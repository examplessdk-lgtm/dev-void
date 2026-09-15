import { Hono } from 'hono';
import type { Handler } from 'hono';
import type { ApiEnv } from '../../env.ts';
import {
  backfillPlatformQueueTokens,
  cliVersionStats,
  systemHealth,
  systemOverview,
} from '../../operator/system-operations.ts';
export type { HealthCheck, HealthResult } from '../../operator/system-operations.ts';
import { CliVersionsPage } from '../views/cli-versions.tsx';
import { DashboardPage } from '../views/dashboard.tsx';

export const adminSystem = new Hono<ApiEnv>();

adminSystem.get('/cli-versions', async (context) => {
  const stats = await cliVersionStats(context.get('db'));
  const tz = (context.req.raw.cf?.timezone as string | undefined) ?? undefined;
  return context.html(<CliVersionsPage {...stats} username={context.get('user').login} tz={tz} />);
});

adminSystem.get('/health', async (context) =>
  context.json(await systemHealth(context.get('db'), context.env, context.req.url)),
);
adminSystem.post('/backfill-queue-tokens', async (context) =>
  context.json(await backfillPlatformQueueTokens(context.env)),
);

export const dashboardHandler: Handler<ApiEnv> = async (context) => {
  const overview = await systemOverview(context.get('db'), context.env);
  return context.html(<DashboardPage {...overview} username={context.get('user').login} />);
};
