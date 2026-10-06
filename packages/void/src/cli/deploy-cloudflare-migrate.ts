import type { DatabaseDialect } from '../config.ts';
import { collectMigrations } from '../migrations/collect.ts';
import { runMySqlMigrations } from '../migrations/runner-mysql.ts';
import { runPgMigrations } from '../migrations/runner-pg.ts';
import {
  verifyGeneratedDeployConfig,
  verifyCloudflareDeployArtifact,
} from './deploy-artifact-validation.ts';
import {
  snapshotBindingIdentities,
  snapshotPassthroughIdentities,
  snapshotPassthroughRawFields,
  reconstructExpectedContainers,
  reconstructExpectedDurableObjectState,
} from './deploy-binding-snapshot.ts';
import { ensureCloudflareAuthSecret } from './deploy-cloudflare-auth.ts';
import { log, getErrorMessage } from './deploy-helpers.ts';
import { applyAndVerifyRemoteD1Migrations } from './deploy-migrations.ts';
import { CloudflareAuthSecretError } from './deploy-resources.ts';
import { type CloudflareDeployDeps } from './deploy-types.ts';
import { type SelfHostSchemaFacts } from './env-validation.ts';
import { type CliLogger } from './log-file.ts';

export async function migrateCloudflareWorker(input: {
  readonly authEnabled: boolean;
  readonly deps: CloudflareDeployDeps;
  readonly root: string;
  readonly accountId: string;
  readonly workerName: string;
  readonly desired: import('./provision.ts').DesiredResourceSet;
  readonly bindingIdentitySnapshot: ReturnType<typeof snapshotBindingIdentities>;
  readonly passthroughIdentitySnapshot: ReturnType<typeof snapshotPassthroughIdentities>;
  readonly passthroughRawFields: ReturnType<typeof snapshotPassthroughRawFields>;
  readonly needsAI: boolean;
  readonly aiBindingName: string;
  readonly expectedContainers: ReturnType<typeof reconstructExpectedContainers>;
  readonly expectedDurableObjectState: ReturnType<typeof reconstructExpectedDurableObjectState>;
  readonly expectedCrons: Array<string>;
  readonly exit: (code: number) => never;
  readonly configPath: string;
  readonly runWrangler: NonNullable<CloudflareDeployDeps['runWrangler']>;
  readonly assertUploaderStillPinned: () => boolean;
  readonly cliLog: CliLogger;
  readonly dialect: DatabaseDialect;
  readonly migrations: ReturnType<typeof collectMigrations>;
  readonly migrationsDir: string;
  readonly d1MigrateToken: string | undefined;
  readonly schemaFacts: SelfHostSchemaFacts;
}): Promise<{
  workerWasMissingBeforeSecretProvisioning: boolean;
  initialAuthSecret: string | undefined;
  appliedMigrations: number;
}> {
  const {
    authEnabled,
    deps,
    root,
    accountId,
    workerName,
    desired,
    bindingIdentitySnapshot,
    passthroughIdentitySnapshot,
    passthroughRawFields,
    needsAI,
    aiBindingName,
    expectedContainers,
    expectedDurableObjectState,
    expectedCrons,
    exit,
    configPath,
    runWrangler,
    assertUploaderStillPinned,
    cliLog,
    dialect,
    migrations,
    migrationsDir,
    d1MigrateToken,
    schemaFacts,
  } = input;

  let workerWasMissingBeforeSecretProvisioning = false;
  let initialAuthSecret: string | undefined;
  const verifyOptions = {
    accountId,
    workerName,
    desired,
    bindingIdentitySnapshot,
    passthroughIdentitySnapshot,
    passthroughRawFields,
    needsAI,
    aiBindingName,
    authEnabled,
    expectedContainers,
    expectedDurableObjectBindings: expectedDurableObjectState.bindings,
    expectedMigrations: expectedDurableObjectState.migrations,
    expectedCrons,
  };

  // 8e. Persistent Better Auth secret — after every local/build-derived gate,
  // but before the first remote migration or worker upload. Existing secrets
  // are adopted unchanged; a missing value is generated once, sent over stdin,
  // and verified by name before deployment can continue.
  if (authEnabled) {
    // Prove the artifact will inherit the secret BEFORE creating it. Wrangler
    // replaces Worker versions on deploy; without `secrets.required`, a secret
    // successfully written to the draft/current Worker can be dropped by the
    // immediately following upload.
    const inheritance = (deps.verifyDeployConfig ?? verifyGeneratedDeployConfig)(
      root,
      verifyOptions,
    );
    if (!inheritance.ok) {
      log.error(
        [
          'deploy: the generated deploy config cannot preserve the Better Auth secret — refusing to deploy.',
          inheritance.reason,
        ]
          .filter(Boolean)
          .join('\n'),
      );
      return exit(1);
    }
    try {
      const authSecret = await (deps.ensureAuthSecret ?? ensureCloudflareAuthSecret)({
        root,
        configPath,
        accountId,
        workerName,
        runWrangler,
        beforeWranglerRun: assertUploaderStillPinned,
      });
      workerWasMissingBeforeSecretProvisioning = authSecret.workerWasMissing === true;
      initialAuthSecret = authSecret.candidateSecret;
      cliLog.info('cloudflare_auth_secret_ready', { created: authSecret.created });
    } catch (error) {
      if (error instanceof CloudflareAuthSecretError) {
        // The uploader check has already logged its own failure.
        if (error.reason !== 'uploader-changed') {
          log.error(error.message);
        }
        return exit(1);
      }
      throw error;
    }
  }

  let appliedMigrations = 0;

  // 9. Apply pending PostgreSQL or MySQL migrations before the Worker upload. The
  // production URL is intentionally provided by the deploy environment rather than recovered
  // from Hyperdrive (Cloudflare never returns the database password). The runners record
  // applied names in `_void_migrations`, so retries are idempotent.
  if (dialect !== 'sqlite' && migrations.length > 0) {
    const mysql = dialect === 'mysql';
    const label = mysql ? 'MySQL' : 'PostgreSQL';
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      log.error(`deploy: DATABASE_URL disappeared before ${label} migrations could run.`);
      return exit(1);
    }
    try {
      const applyMigrations = mysql
        ? (deps.applyMySqlMigrations ?? runMySqlMigrations)
        : (deps.applyPostgresMigrations ?? runPgMigrations);
      const applied = await applyMigrations(migrationsDir, databaseUrl);
      appliedMigrations = applied.length;
      cliLog.info(mysql ? 'cloudflare_mysql_migrations' : 'cloudflare_postgres_migrations', {
        applied: applied.length,
      });
      if (applied.length > 0) {
        log.success(
          `Applied ${applied.length} ${label} migration${applied.length === 1 ? '' : 's'}.`,
        );
      }
    } catch (err) {
      log.error(`deploy: ${label} migrations failed — ${getErrorMessage(err)}`);
      return exit(1);
    }
  }

  if (
    !(await applyAndVerifyRemoteD1Migrations(
      d1MigrateToken,
      configPath,
      runWrangler,
      assertUploaderStillPinned,
    ))
  ) {
    return exit(1);
  }

  if (
    !verifyCloudflareDeployArtifact(root, deps, {
      ...verifyOptions,
      requiredSecretNames: schemaFacts.requiredKeys,
    })
  ) {
    return exit(1);
  }
  return { workerWasMissingBeforeSecretProvisioning, initialAuthSecret, appliedMigrations };
}
