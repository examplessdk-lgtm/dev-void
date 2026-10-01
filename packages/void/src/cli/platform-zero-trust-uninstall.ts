/**
 * Uninstall turns off the platform API, and only that API can remove the
 * Cloudflare Access applications project Zero Trust created. The shared
 * project application covers every hostname under the application domain, so
 * a left-over one keeps asking for sign-in on hosts Void no longer serves.
 * Uninstall therefore reads the saved Zero Trust state straight from
 * PostgreSQL, which works whether or not the API still answers, and refuses
 * while anything remains to clean up or the state cannot be read.
 */

// Mirrors the platform setting key in platform/packages/api/src/zero-trust/configuration.ts.
const ZERO_TRUST_SETTING = 'zeroTrust.configuration';
// Mirrors lockZeroTrustConfiguration in platform/packages/api/src/zero-trust/lock.ts.
const ZERO_TRUST_LOCK = "hashtext('zero-trust:configuration')";
const LISTED_APPLICATIONS = 20;

type QueryConnection = Readonly<{
  query: <Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: ReadonlyArray<unknown>,
  ) => Promise<{ rows: ReadonlyArray<Row> }>;
}>;

export type PlatformZeroTrustApplication = Readonly<{
  role: string;
  id: string | null;
  name: string | null;
}>;

export type PlatformProjectZeroTrustState = Readonly<{
  /** Zero Trust is enabled, or a configure, reconcile, or disable operation is unfinished. */
  active: boolean;
  /** Hostname patterns of the shared project application, when it is recorded. */
  destinations: ReadonlyArray<string>;
  /** Void-managed Access applications that may still exist in Cloudflare. */
  applications: ReadonlyArray<PlatformZeroTrustApplication>;
}>;

type ProjectApplicationRow = Readonly<{
  project_id: string;
  bypass_application_id: string | null;
  bypass_application_name: string | null;
  protected_application_id: string | null;
  protected_application_name: string | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalText(value: unknown, label: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`the saved ${label} is malformed`);
  }
  return value;
}

function savedApplication(
  value: unknown,
  label: string,
): Readonly<{ id: string; name: string; destinations: ReadonlyArray<string> }> | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') {
    throw new Error(`the saved ${label} is malformed`);
  }
  const destinations = Array.isArray(value.destinations)
    ? value.destinations.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return { id: value.id, name: value.name, destinations };
}

/**
 * Interpret the saved configuration and project rows. Anything that does not
 * have the expected shape throws, so the caller refuses instead of guessing.
 */
export function projectZeroTrustUninstallState(
  setting: unknown,
  projectRows: ReadonlyArray<ProjectApplicationRow>,
): PlatformProjectZeroTrustState {
  const applications: Array<PlatformZeroTrustApplication> = [];
  let active = false;
  let destinations: ReadonlyArray<string> = [];
  if (setting !== null && setting !== undefined) {
    if (!isRecord(setting) || typeof setting.enabled !== 'boolean') {
      throw new Error('the saved Zero Trust configuration is malformed');
    }
    const operation = setting.operation ?? null;
    if (operation !== null && !isRecord(operation)) {
      throw new Error('the saved Zero Trust operation is malformed');
    }
    active = setting.enabled || operation !== null;
    const wildcard = savedApplication(setting.wildcardApplication, 'shared project application');
    const health = savedApplication(setting.healthApplication, 'health check exception');
    // Names are saved before the application is created, so an unfinished
    // operation may own an application whose id was never recorded.
    const wildcardName = optionalText(setting.wildcardApplicationName, 'application name');
    const healthName = optionalText(setting.healthApplicationName, 'application name');
    if (wildcard || (active && wildcardName)) {
      applications.push({
        role: 'shared project application',
        id: wildcard?.id ?? null,
        name: wildcard?.name ?? wildcardName,
      });
    }
    if (health || (active && healthName)) {
      applications.push({
        role: 'health check exception',
        id: health?.id ?? null,
        name: health?.name ?? healthName,
      });
    }
    destinations = wildcard?.destinations ?? [];
  }
  for (const row of projectRows) {
    if (row.bypass_application_id || row.bypass_application_name) {
      applications.push({
        role: `public exception for ${row.project_id}`,
        id: row.bypass_application_id,
        name: row.bypass_application_name,
      });
    }
    if (row.protected_application_id || row.protected_application_name) {
      applications.push({
        role: `custom domain application for ${row.project_id}`,
        id: row.protected_application_id,
        name: row.protected_application_name,
      });
    }
  }
  return { active, destinations, applications };
}

/** Read the project Zero Trust state from the platform database. */
export async function readPlatformProjectZeroTrustStateConnection(
  client: QueryConnection,
): Promise<PlatformProjectZeroTrustState> {
  const tables = await client.query<{ settings: boolean; projects: boolean }>(
    `SELECT to_regclass('public.platform_settings') IS NOT NULL AS "settings",
            to_regclass('public.project_zero_trust') IS NOT NULL AS "projects"`,
  );
  const present = tables.rows[0];
  if (!present) {
    throw new Error('the database did not report its Zero Trust tables');
  }
  const setting = present.settings
    ? (
        await client.query<{ value: unknown }>(
          'SELECT "value" FROM "platform_settings" WHERE "key" = $1',
          [ZERO_TRUST_SETTING],
        )
      ).rows[0]?.value
    : undefined;
  const projectRows = present.projects
    ? (
        await client.query<ProjectApplicationRow>(
          `SELECT "project_id", "bypass_application_id", "bypass_application_name",
                  "protected_application_id", "protected_application_name"
           FROM "project_zero_trust"
           WHERE "bypass_application_id" IS NOT NULL
              OR "bypass_application_name" IS NOT NULL
              OR "protected_application_id" IS NOT NULL
              OR "protected_application_name" IS NOT NULL
           ORDER BY "project_id"`,
        )
      ).rows
    : [];
  return projectZeroTrustUninstallState(setting, projectRows);
}

/**
 * Take the Zero Trust configuration lock exclusively on this session. Every
 * API path that records or creates a Void-managed Access application holds
 * the same lock, so none can commit until the returned release runs.
 */
export async function lockPlatformProjectZeroTrustConnection(
  client: QueryConnection,
): Promise<() => Promise<void>> {
  await client.query(`SELECT pg_advisory_lock(${ZERO_TRUST_LOCK})`);
  let released = false;
  return async () => {
    if (released) {
      return;
    }
    released = true;
    await client.query(`SELECT pg_advisory_unlock(${ZERO_TRUST_LOCK})`);
  };
}

function formatApplications(applications: ReadonlyArray<PlatformZeroTrustApplication>): string {
  const lines = applications
    .slice(0, LISTED_APPLICATIONS)
    .map(
      (application) =>
        `  ${application.role}: ${application.name ?? '(name not recorded)'}${application.id ? ` (${application.id})` : ''}`,
    );
  if (applications.length > LISTED_APPLICATIONS) {
    lines.push(`  …and ${applications.length - LISTED_APPLICATIONS} more`);
  }
  return lines.join('\n');
}

const DASHBOARD_HINT =
  'To lift sign-in right away, delete these applications in the Cloudflare dashboard under Zero Trust → Access → Applications.';

/**
 * Refuse to uninstall while project Zero Trust still owns Access applications,
 * or while its state cannot be read. Runs before uninstall changes anything.
 */
export async function assertProjectZeroTrustAllowsUninstall(
  read: (() => Promise<PlatformProjectZeroTrustState>) | undefined,
): Promise<void> {
  let state: PlatformProjectZeroTrustState;
  try {
    if (!read) {
      throw new Error('no platform database connection is available');
    }
    state = await read();
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).replace(
      /^platform: /,
      '',
    );
    throw new Error(
      [
        `platform: Refusing to uninstall because the project Zero Trust state could not be read from the platform database: ${reason}`,
        'Uninstall turns off the platform API, which Void needs to remove the Cloudflare Access applications that project Zero Trust created.',
        'Make the installation database reachable (export VOID_PLATFORM_DATABASE_URL if this machine has not recorded it), then retry. If project Zero Trust was ever enabled, run `void platform zero-trust disable` first.',
      ].join('\n'),
    );
  }
  if (state.active) {
    const covered = state.destinations.length
      ? ` on ${state.destinations.join(' and ')}`
      : ' on every hostname under the application domain';
    throw new Error(
      [
        'platform: Refusing to uninstall while project Zero Trust is enabled or still changing.',
        `Uninstall turns off the platform API, so Void could no longer remove its Cloudflare Access applications, and Access would keep asking for sign-in${covered}, including hostnames Void does not serve.`,
        'Run `void platform zero-trust disable`, rerun it until `void platform zero-trust status` reports Zero Trust disabled with no operation running, then retry the uninstall.',
        'If the platform API does not answer, bring it back with `void platform enable` or `void platform repair` first.',
        ...(state.applications.length
          ? ['Void-managed Access applications:', formatApplications(state.applications)]
          : []),
        DASHBOARD_HINT,
      ].join('\n'),
    );
  }
  if (state.applications.length) {
    throw new Error(
      [
        'platform: Refusing to uninstall while Void-managed Access applications from project Zero Trust remain.',
        'Zero Trust is disabled, but it could not remove the applications of some projects. Hourly maintenance retries them while the platform is enabled. Retry the uninstall once they are gone.',
        'Void-managed Access applications:',
        formatApplications(state.applications),
        `${DASHBOARD_HINT} Hourly maintenance then clears Void's records of them.`,
      ].join('\n'),
    );
  }
}
