import { and, eq, gt, inArray, isNull, lt, or } from 'drizzle-orm';
import { Hono } from 'hono';
import { getOwnedProjectsByUserId, type Db } from '../db.ts';
import { type ApiEnv, isDevBypass } from '../env.ts';
import { projectOwnershipPeriods, projects as projectsTable } from '../schema.ts';
import { getCurrentBillingPeriodStart } from '../tiers.ts';
import type { Project } from '../types.ts';
import { requireProjectRouteCapability } from './project-access.ts';

const projectUsage = new Hono<ApiEnv>()

  // Project usage for current billing period
  .get('/:id/usage', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'read');
    if (access instanceof Response) {
      return access;
    }

    // Dev bypass — skip slow CF Analytics Engine API calls
    if (isDevBypass(context.env)) {
      return context.json({
        projectId,
        billingPeriodStart: new Date().toISOString(),
        requests: 0,
        bandwidthBytes: 0,
        aiNeurons: 0,
      });
    }

    const since = getCurrentBillingPeriodStart(access.owner.billing_cycle_start);
    const requestsDataset = getRequestsDataset(context.env);
    const [usage, aiUsage] = await Promise.all([
      queryProjectUsage(
        context.env.CF_ACCOUNT_ID,
        context.env.CF_API_TOKEN,
        requestsDataset,
        projectId,
        since,
      ),
      queryProjectAiUsage(
        context.env.CF_ACCOUNT_ID,
        context.env.CF_API_TOKEN,
        context.env.AI_GATEWAY_ID ?? 'void',
        projectId,
        since,
      ),
    ]);

    return context.json({
      projectId,
      billingPeriodStart: since.toISOString(),
      ...usage,
      aiNeurons: aiUsage.neurons,
    });
  });

const accountUsage = new Hono<ApiEnv>()

  // Aggregate usage across all user's projects
  .get('/', async (context) => {
    const since = getCurrentBillingPeriodStart(context.get('user').billing_cycle_start);
    const until = new Date();
    const projectWindows = await getAccountUsageProjectWindows(
      context.get('db'),
      context.get('user').id,
      since,
      until,
    );
    if (projectWindows.length === 0) {
      return context.json({ requests: 0, bandwidthBytes: 0, aiNeurons: 0, projects: [] });
    }

    // Dev bypass — skip slow CF Analytics Engine API calls
    if (isDevBypass(context.env)) {
      return context.json({
        billingPeriodStart: since.toISOString(),
        requests: 0,
        bandwidthBytes: 0,
        aiNeurons: 0,
        projects: projectWindows.map(({ project }) => ({
          projectId: project.id,
          slug: project.slug,
          requests: 0,
          bandwidthBytes: 0,
          aiNeurons: 0,
        })),
      });
    }

    const requestsDataset = getRequestsDataset(context.env);

    const [usageMap, ...aiUsages] = await Promise.all([
      queryBatchProjectUsageWindows(
        context.env.CF_ACCOUNT_ID,
        context.env.CF_API_TOKEN,
        requestsDataset,
        projectWindows,
      ),
      ...projectWindows.map(async ({ project, intervals }) =>
        intervals.reduce(
          async (totalPromise, interval) => {
            const [total, usage] = await Promise.all([
              totalPromise,
              queryProjectAiUsage(
                context.env.CF_ACCOUNT_ID,
                context.env.CF_API_TOKEN,
                context.env.AI_GATEWAY_ID ?? 'void',
                project.id,
                interval.start,
                interval.end,
              ),
            ]);
            return { neurons: total.neurons + usage.neurons };
          },
          Promise.resolve({ neurons: 0 }),
        ),
      ),
    ]);
    const projectUsages = projectWindows.map(({ project }, i) => ({
      projectId: project.id,
      slug: project.slug,
      ...(usageMap.get(project.id) ?? ZERO_USAGE),
      aiNeurons: aiUsages[i].neurons,
    }));

    const totals = projectUsages.reduce(
      (acc, u) => ({
        requests: acc.requests + u.requests,
        bandwidthBytes: acc.bandwidthBytes + u.bandwidthBytes,
        aiNeurons: acc.aiNeurons + u.aiNeurons,
      }),
      { requests: 0, bandwidthBytes: 0, aiNeurons: 0 },
    );

    return context.json({
      billingPeriodStart: since.toISOString(),
      ...totals,
      projects: projectUsages,
    });
  });

type AnalyticsRow = Readonly<{
  requests: number;
  bandwidth_bytes: number;
}>;

type BatchAnalyticsRow = AnalyticsRow & {
  blob1: string;
};

type TopProjectTrafficRow = BatchAnalyticsRow & {
  last_seen: string;
};

type TopProjectTrafficEntry = Readonly<{
  projectId: string;
  requests: number;
  bandwidthBytes: number;
  lastSeen: string;
}>;

type ProjectRequestOverviewRow = Readonly<{
  project_id: string;
  bucket: number;
  last_seen: string;
  requests: number;
  responses_4xx: number;
  responses_5xx: number;
}>;

type ProjectRequestOverview = {
  requests5m: number;
  requests15m: number;
  lastSeenAt: string | null;
  sparkline5m: Array<number>;
  responses4xx15m: number;
  responses5xx15m: number;
  errorRate5xx15m: number;
};

function getRequestsDataset(env: { REQUESTS_DATASET?: string; PLATFORM_ENV?: string }): string {
  if (env.REQUESTS_DATASET) {
    return env.REQUESTS_DATASET;
  }
  return env.PLATFORM_ENV === 'staging' ? 'void_requests_staging' : 'void_requests';
}

async function queryProjectUsage(
  accountId: string,
  apiToken: string,
  requestsDataset: string,
  projectId: string,
  since: Date,
): Promise<{ requests: number; bandwidthBytes: number }> {
  const sinceStr = since.toISOString().replace('T', ' ').slice(0, 19);
  const query = `
    SELECT
      SUM(_sample_interval * double1) as requests,
      SUM(_sample_interval * double2) as bandwidth_bytes
    FROM ${requestsDataset}
    WHERE blob1 = '${projectId}'
      AND timestamp >= toDateTime('${sinceStr}')
  `;

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'text/plain',
      },
      body: query,
    },
  );

  if (!response.ok) {
    return { requests: 0, bandwidthBytes: 0 };
  }

  const result = (await response.json()) as { data: ReadonlyArray<AnalyticsRow> };
  const row = result.data?.[0];
  return {
    requests: Math.round(row?.requests ?? 0),
    bandwidthBytes: Math.round(row?.bandwidth_bytes ?? 0),
  };
}

type UsageEntry = Readonly<{ requests: number; bandwidthBytes: number }>;
const ZERO_USAGE: UsageEntry = { requests: 0, bandwidthBytes: 0 };

type AccountUsageInterval = Readonly<{ start: Date; end: Date }>;
type AccountUsageProjectWindow = Readonly<{
  project: Project;
  intervals: ReadonlyArray<AccountUsageInterval>;
}>;

function databaseTimestampMs(value: string): number {
  const normalized = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(value)
    ? value
    : `${value.replace(' ', 'T')}Z`;
  return Date.parse(normalized);
}

/**
 * Resolve the portions of the actor's current billing window for which they
 * owned each project. Projects without ownership-period rows are legacy/test
 * data and retain the former current-owner behavior.
 */
async function getAccountUsageProjectWindows(
  db: Db,
  userId: string,
  since: Date,
  until: Date,
): Promise<ReadonlyArray<AccountUsageProjectWindow>> {
  const sinceIso = since.toISOString();
  const untilIso = until.toISOString();
  const rows = await db
    .select({
      project: projectsTable,
      startsAt: projectOwnershipPeriods.starts_at,
      endsAt: projectOwnershipPeriods.ends_at,
    })
    .from(projectOwnershipPeriods)
    .innerJoin(projectsTable, eq(projectOwnershipPeriods.project_id, projectsTable.id))
    .where(
      and(
        eq(projectOwnershipPeriods.owner_user_id, userId),
        lt(projectOwnershipPeriods.starts_at, untilIso),
        or(isNull(projectOwnershipPeriods.ends_at), gt(projectOwnershipPeriods.ends_at, sinceIso)),
      ),
    );

  const windows = new Map<string, { project: Project; intervals: Array<AccountUsageInterval> }>();
  for (const row of rows) {
    const start = new Date(Math.max(since.getTime(), databaseTimestampMs(row.startsAt)));
    const end = new Date(
      Math.min(until.getTime(), row.endsAt ? databaseTimestampMs(row.endsAt) : until.getTime()),
    );
    if (start < end) {
      const entry = windows.get(row.project.id) ?? { project: row.project, intervals: [] };
      entry.intervals.push({ start, end });
      windows.set(row.project.id, entry);
    }
  }

  // Compatibility for projects created by an older runtime (and lightweight
  // test fixtures) before ownership periods were written.
  const currentlyOwned = await getOwnedProjectsByUserId(db, userId);
  const currentIds = currentlyOwned.map((project) => project.id);
  const projectsWithAnyPeriod = new Set<string>();
  if (currentIds.length > 0) {
    const periodRows = await db
      .select({ projectId: projectOwnershipPeriods.project_id })
      .from(projectOwnershipPeriods)
      .where(inArray(projectOwnershipPeriods.project_id, currentIds));
    for (const row of periodRows) {
      projectsWithAnyPeriod.add(row.projectId);
    }
  }
  for (const project of currentlyOwned) {
    if (!windows.has(project.id) && !projectsWithAnyPeriod.has(project.id)) {
      windows.set(project.id, { project, intervals: [{ start: since, end: until }] });
    }
  }

  return [...windows.values()].sort((a, b) =>
    b.project.created_at.localeCompare(a.project.created_at),
  );
}

function analyticsStringLiteral(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

async function queryBatchProjectUsageWindows(
  accountId: string,
  apiToken: string,
  requestsDataset: string,
  windows: ReadonlyArray<AccountUsageProjectWindow>,
): Promise<Map<string, UsageEntry>> {
  if (windows.length === 0) {
    return new Map();
  }
  const predicates = windows.flatMap(({ project, intervals }) =>
    intervals.map(
      ({ start, end }) =>
        `(blob1 = ${analyticsStringLiteral(project.id)} AND timestamp >= toDateTime(${analyticsStringLiteral(formatAnalyticsDate(start))}) AND timestamp < toDateTime(${analyticsStringLiteral(formatAnalyticsDate(end))}))`,
    ),
  );
  const query = `
    SELECT
      blob1,
      SUM(_sample_interval * double1) as requests,
      SUM(_sample_interval * double2) as bandwidth_bytes
    FROM ${requestsDataset}
    WHERE ${predicates.join('\n      OR ')}
    GROUP BY blob1
  `;

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'text/plain',
      },
      body: query,
    },
  );
  if (!response.ok) {
    return new Map();
  }
  const json = (await response.json()) as { data: ReadonlyArray<BatchAnalyticsRow> };
  return new Map(
    (json.data ?? []).map((row) => [
      row.blob1,
      {
        requests: Math.round(row.requests ?? 0),
        bandwidthBytes: Math.round(row.bandwidth_bytes ?? 0),
      },
    ]),
  );
}

async function queryBatchProjectUsage(
  accountId: string,
  apiToken: string,
  requestsDataset: string,
  projectIds: ReadonlyArray<string>,
  since: Date,
): Promise<Map<string, UsageEntry>> {
  if (projectIds.length === 0) {
    return new Map();
  }

  const sinceStr = since.toISOString().replace('T', ' ').slice(0, 19);
  const inList = projectIds.map((id) => `'${id}'`).join(', ');
  const query = `
    SELECT
      blob1,
      SUM(_sample_interval * double1) as requests,
      SUM(_sample_interval * double2) as bandwidth_bytes
    FROM ${requestsDataset}
    WHERE blob1 IN (${inList})
      AND timestamp >= toDateTime('${sinceStr}')
    GROUP BY blob1
  `;

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'text/plain',
      },
      body: query,
    },
  );

  if (!response.ok) {
    return new Map();
  }

  const json = (await response.json()) as { data: ReadonlyArray<BatchAnalyticsRow> };
  const result = new Map<string, UsageEntry>();
  for (const row of json.data ?? []) {
    result.set(row.blob1, {
      requests: Math.round(row.requests ?? 0),
      bandwidthBytes: Math.round(row.bandwidth_bytes ?? 0),
    });
  }
  return result;
}

async function queryTopProjectTraffic(
  accountId: string,
  apiToken: string,
  requestsDataset: string,
  since: Date,
  limit: number,
): Promise<ReadonlyArray<TopProjectTrafficEntry>> {
  if (limit <= 0) {
    return [];
  }

  const sinceStr = since.toISOString().replace('T', ' ').slice(0, 19);
  const query = `
    SELECT
      blob1,
      MAX(timestamp) as last_seen,
      SUM(_sample_interval * double1) as requests,
      SUM(_sample_interval * double2) as bandwidth_bytes
    FROM ${requestsDataset}
    WHERE timestamp >= toDateTime('${sinceStr}')
      AND blob2 IN ('static', 'ssr', 'isr')
      AND blob3 IN ('GET', 'HEAD')
    GROUP BY blob1
    ORDER BY requests DESC
    LIMIT ${limit}
  `;

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'text/plain',
      },
      body: query,
    },
  );

  if (!response.ok) {
    return [];
  }

  const json = (await response.json()) as { data: ReadonlyArray<TopProjectTrafficRow> };
  return (json.data ?? []).map((row) => ({
    projectId: row.blob1,
    requests: Math.round(row.requests ?? 0),
    bandwidthBytes: Math.round(row.bandwidth_bytes ?? 0),
    lastSeen: row.last_seen,
  }));
}

function formatAnalyticsDate(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function normalizeAnalyticsDate(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  if (value.includes('T')) {
    return value;
  }
  return `${value.replace(' ', 'T')}Z`;
}

function emptyRequestOverview(): ProjectRequestOverview {
  const bucketCount = 20;
  return {
    requests5m: 0,
    requests15m: 0,
    lastSeenAt: null,
    sparkline5m: Array.from({ length: bucketCount }, () => 0),
    responses4xx15m: 0,
    responses5xx15m: 0,
    errorRate5xx15m: 0,
  };
}

async function queryProjectRequestOverview(
  accountId: string,
  apiToken: string,
  requestsDataset: string,
  projectIds: ReadonlyArray<string>,
  now = new Date(),
): Promise<Map<string, ProjectRequestOverview>> {
  const bucketSizeSeconds = 15;
  const bucketCount = 20;
  const healthWindowMs = 15 * 60 * 1000;
  const overview = new Map<string, ProjectRequestOverview>();
  for (const projectId of projectIds) {
    overview.set(projectId, emptyRequestOverview());
  }
  if (projectIds.length === 0) {
    return overview;
  }

  const since = new Date(now.getTime() - healthWindowMs);
  const sinceStr = formatAnalyticsDate(since);
  const inList = projectIds.map((id) => `'${id}'`).join(', ');
  const query = `
    SELECT
      blob1 as project_id,
      intDiv(toUnixTimestamp(timestamp), ${bucketSizeSeconds}) * ${bucketSizeSeconds} as bucket,
      MAX(timestamp) as last_seen,
      SUM(_sample_interval * double1) as requests,
      SUM(if(blob4 LIKE '4%', _sample_interval * double1, 0.0)) as responses_4xx,
      SUM(if(blob4 LIKE '5%', _sample_interval * double1, 0.0)) as responses_5xx
    FROM ${requestsDataset}
    WHERE blob1 IN (${inList})
      AND timestamp >= toDateTime('${sinceStr}')
    GROUP BY blob1, bucket
    ORDER BY bucket ASC
  `;

  let json: { data: ReadonlyArray<ProjectRequestOverviewRow> };
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'text/plain',
        },
        body: query,
      },
    );

    if (!response.ok) {
      return overview;
    }

    json = (await response.json()) as { data: ReadonlyArray<ProjectRequestOverviewRow> };
  } catch {
    return overview;
  }

  const firstSparkBucket =
    Math.floor(now.getTime() / 1000 / bucketSizeSeconds) * bucketSizeSeconds -
    (bucketCount - 1) * bucketSizeSeconds;

  for (const row of json.data ?? []) {
    const entry = overview.get(row.project_id);
    if (!entry) {
      continue;
    }

    const requests = Math.round(row.requests ?? 0);
    const responses4xx = Math.round(row.responses_4xx ?? 0);
    const responses5xx = Math.round(row.responses_5xx ?? 0);
    entry.requests15m += requests;
    entry.responses4xx15m += responses4xx;
    entry.responses5xx15m += responses5xx;

    const normalizedLastSeen = normalizeAnalyticsDate(row.last_seen);
    if (
      normalizedLastSeen &&
      (!entry.lastSeenAt || new Date(normalizedLastSeen) > new Date(entry.lastSeenAt))
    ) {
      entry.lastSeenAt = normalizedLastSeen;
    }

    const bucket = Number(row.bucket);
    if (bucket >= firstSparkBucket) {
      const index = Math.floor((bucket - firstSparkBucket) / bucketSizeSeconds);
      if (index >= 0 && index < bucketCount) {
        entry.sparkline5m[index] += requests;
        entry.requests5m += requests;
      }
    }
  }

  for (const entry of overview.values()) {
    entry.errorRate5xx15m = entry.requests15m === 0 ? 0 : entry.responses5xx15m / entry.requests15m;
  }

  return overview;
}

type AiGatewayResponse = Readonly<{
  data: {
    viewer: {
      accounts: ReadonlyArray<{
        aiGatewayRequests: ReadonlyArray<{ sum: { cost: number } }>;
      }>;
    };
  };
}>;

const COST_PER_NEURON = 0.000011;

async function queryProjectAiUsage(
  accountId: string,
  apiToken: string,
  gatewayId: string,
  projectId: string,
  since: Date,
  until?: Date,
  failOnError = false,
): Promise<{ neurons: number }> {
  const query = `query {
  viewer {
    accounts(filter: { accountTag: "${accountId}" }) {
      aiGatewayRequests(
        filter: {
          gatewayId: "${gatewayId}"
          metadata_projectId: "${projectId}"
          datetime_geq: "${since.toISOString()}"
          ${until ? `datetime_lt: "${until.toISOString()}"` : ''}
        }
      ) {
        sum { cost }
      }
    }
  }
}`;

  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    if (failOnError) {
      throw new Error(`AI usage query failed with HTTP ${response.status}`);
    }
    return { neurons: 0 };
  }

  const result = (await response.json()) as AiGatewayResponse;
  const requests = result.data?.viewer?.accounts?.[0]?.aiGatewayRequests;
  if (!requests && failOnError) {
    throw new Error('AI usage query returned no account data');
  }
  const cost = requests?.[0]?.sum?.cost ?? 0;
  return { neurons: Math.round(cost / COST_PER_NEURON) };
}

export {
  getRequestsDataset,
  queryProjectUsage,
  queryBatchProjectUsage,
  queryBatchProjectUsageWindows,
  queryTopProjectTraffic,
  queryProjectRequestOverview,
  queryProjectAiUsage,
  getAccountUsageProjectWindows,
  projectUsage,
  accountUsage,
  ZERO_USAGE,
};
