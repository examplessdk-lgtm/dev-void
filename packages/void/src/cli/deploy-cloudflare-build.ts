import { execSync } from 'node:child_process';
import {
  parseRootWranglerConfig,
  readStoredResourceName,
  resolveD1MigrateTarget,
  assertCloudflareDurableObjectLifecycleSupported,
  type ExistingCloudflareWorker,
  type ApprovedCloudflareKvBinding,
} from '@void/deploy-cloudflare';
import { dirname } from 'pathslash';
import { type VoidConfig } from '../config.ts';
import type { DatabaseDialect } from '../config.ts';
import { collectMigrations } from '../migrations/collect.ts';
import { SqliteMigrationError } from '../migrations/sqlite-validation.ts';
import { detectFramework } from '../plugin-inference.ts';
import { CLOUDFLARE_DEPLOY_BUILD_ENV } from '../shared/env.ts';
import { CLOUDFLARE_PRESERVE_BINDINGS_BUILD_ENV } from '../shared/version-metadata.ts';
import { prepareCfBuildOutput, prepareCfFrameworkBuildOutput } from './cf-build-output.ts';
import {
  readGeneratedDeployConfig,
  deduplicateGeneratedCompatibilityFlags,
  validateCloudflarePostBuildEnv,
  resolveGeneratedDeployConfigPathDefault,
} from './deploy-artifact-validation.ts';
import {
  snapshotBindingIdentities,
  DEPLOY_BINDING_IDENTITY_FIELDS,
  bindingIdentityKey,
} from './deploy-binding-snapshot.ts';
import { prepareCloudflareFrameworkArtifact } from './deploy-cloudflare-static.ts';
import { log, getErrorMessage, getExitCode } from './deploy-helpers.ts';
import {
  validateAuthMigrationSchema,
  assertRemoteMigrationsDeployable,
  checkWranglerMigrationApplySet,
} from './deploy-migrations.ts';
import { requireProvisionModule } from './deploy-provision.ts';
import {
  scrubManagedDeployBuildMarkers,
  scrubWranglerAuthCredentials,
  deployChildEnv,
} from './deploy-transport.ts';
import { type CloudflareDeployDeps } from './deploy-types.ts';
import { type SelfHostSchemaFacts } from './env-validation.ts';
import { resolveProjectCommand } from './preset.ts';

export async function buildCloudflareWorker(input: {
  readonly accountId: string;
  readonly apiBaseUrl: string;
  readonly existingWorker: ExistingCloudflareWorker | null;
  readonly deps: CloudflareDeployDeps;
  readonly frameworkPreset: import('./preset.ts').FrameworkPreset | undefined;
  readonly voidConfig: VoidConfig;
  readonly root: string;
  readonly exit: (code: number) => never;
  readonly detectedFramework: ReturnType<typeof detectFramework>;
  readonly configPath: string;
  readonly workerName: string;
  readonly schemaFacts: SelfHostSchemaFacts;
  readonly needsAI: boolean;
  readonly aiBindingName: string;
  readonly assertUploaderStillPinned: () => boolean;
  readonly migrationsDir: string;
  readonly dialect: DatabaseDialect;
  readonly atomic: boolean;
  readonly runWrangler: NonNullable<CloudflareDeployDeps['runWrangler']>;
  readonly authEnabled: boolean;
  readonly approvedHandoffKv: Array<ApprovedCloudflareKvBinding>;
  readonly desired: import('./provision.ts').DesiredResourceSet;
  readonly bindingIdentitySnapshot: ReturnType<typeof snapshotBindingIdentities>;
}): Promise<{
  migrations: ReturnType<typeof collectMigrations>;
  d1MigrateToken: string | undefined;
  generatedConfigPath: string;
  prepareBuildOutput: () => ReturnType<typeof prepareCfBuildOutput>;
}> {
  const {
    accountId,
    apiBaseUrl,
    existingWorker,
    deps,
    frameworkPreset,
    voidConfig,
    root,
    exit,
    detectedFramework,
    configPath,
    workerName,
    schemaFacts,
    needsAI,
    aiBindingName,
    assertUploaderStillPinned,
    migrationsDir,
    dialect,
    atomic,
    runWrangler,
    authEnabled,
    approvedHandoffKv,
    desired,
    bindingIdentitySnapshot,
  } = input;

  const buildChildEnv = scrubManagedDeployBuildMarkers(
    scrubWranglerAuthCredentials(deployChildEnv(accountId, apiBaseUrl)),
  );
  // Tell void:env to build Worker vars from portable production dotenv files
  // only. Outside this deploy path Vite keeps its standard dotenv behavior,
  // but local files cannot be serialized into the artifact this command uploads.
  requireProvisionModule().deleteEnvVarCaseAware(buildChildEnv, CLOUDFLARE_DEPLOY_BUILD_ENV);
  buildChildEnv[CLOUDFLARE_DEPLOY_BUILD_ENV] = '1';
  requireProvisionModule().deleteEnvVarCaseAware(
    buildChildEnv,
    CLOUDFLARE_PRESERVE_BINDINGS_BUILD_ENV,
  );
  if (existingWorker) {
    buildChildEnv[CLOUDFLARE_PRESERVE_BINDINGS_BUILD_ENV] = '1';
  }
  // Pin NODE_ENV=production for the build too, so the build and the env-schema probes evaluate
  // env.ts under the SAME environment. `vite build` only DEFAULTS NODE_ENV to production when it
  // is unset (`if (!isNodeEnvSet) process.env.NODE_ENV = defaultNodeEnv`), so an ambient
  // NODE_ENV=development would otherwise build a development schema while the probes (pinned
  // production) derive a production one — the exact divergence the probe pin exists to close.
  // Scrub any ambient spelling first (case-aware on win32) so it cannot shadow the pin.
  requireProvisionModule().deleteEnvVarCaseAware(buildChildEnv, 'NODE_ENV');
  buildChildEnv.NODE_ENV = 'production';
  const runBuild =
    deps.runBuild ??
    ((env: NodeJS.ProcessEnv) => {
      const command = frameworkPreset
        ? (voidConfig.inference?.build ?? resolveProjectCommand(root, frameworkPreset.buildCommand))
        : resolveProjectCommand(root, 'vite build');
      execSync(command, { cwd: root, stdio: 'inherit', env });
    });
  // The wrangler UPLOADER was pinned into `wranglerUploaderHashBefore` at the START of the deploy
  // (before the env-schema probe and the pre-build credentialed runs), and `assertUploaderStillPinned`
  // re-checks it against that ONE baseline before every credentialed spawn — never re-baselined. The
  // build below runs untrusted project code with the parent's Cloudflare creds scrubbed, so it can
  // only edit FILES — but that INCLUDES the `wrangler-dist` bundle every post-build credentialed
  // wrangler run (the secret list, the remote D1 migrate, and the deploy) executes — so re-verify
  // against the same baseline right after it, and again immediately before each spawn.
  try {
    runBuild(buildChildEnv);
  } catch (err) {
    log.error(`deploy: build failed — ${getErrorMessage(err)}`);
    return exit(getExitCode(err));
  }
  log.step('Preparing deployment...');
  if (detectedFramework && frameworkPreset) {
    try {
      await (deps.prepareFrameworkArtifact ?? prepareCloudflareFrameworkArtifact)(
        root,
        configPath,
        accountId,
        workerName,
        voidConfig,
        detectedFramework,
        frameworkPreset,
        schemaFacts.requiredKeys,
        needsAI ? { binding: aiBindingName } : undefined,
        existingWorker !== null,
      );
    } catch (error) {
      log.error(
        `deploy: could not prepare ${detectedFramework.name} for Cloudflare — ${getErrorMessage(error)}`,
      );
      return exit(1);
    }
  }
  // Early fail — re-check right after the build, before the ground-truth gates do any work. No
  // remote mutation has happened since the baseline was pinned, so a changed/unverifiable uploader
  // here leaves nothing half-done. Each credentialed spawn below re-checks again immediately.
  if (!assertUploaderStillPinned()) {
    return exit(1);
  }

  // Re-collect the checked-in migrations from disk AFTER the build. `vite build` runs
  // arbitrary project plugins that could add or rewrite `db/migrations` SQL (or the
  // `migrations_dir` presence), and step 9's `wrangler d1 migrations apply` reads the
  // LIVE post-build files — so every migration that can reach remote D1 must be validated
  // against exactly what is on disk now, not a pre-build snapshot. This one set feeds both
  // the auth-schema check (8c) and the local migration gates (8d).
  const migrations = collectMigrations(migrationsDir);
  if (existingWorker && migrations.length) {
    throw new Error(
      'The build added database migrations. Link the existing site before making schema changes.',
    );
  }

  // A build plugin can add migrations after the pre-build source scan. Require the production URL
  // again against the post-build ground truth so no injected migration can be silently skipped.
  if (dialect !== 'sqlite' && migrations.length > 0 && !process.env.DATABASE_URL) {
    log.error(
      `deploy: the build added ${dialect === 'mysql' ? 'MySQL' : 'PostgreSQL'} migrations, but DATABASE_URL is not set. ` +
        'Refusing to upload a Worker against an unmigrated database.',
    );
    return exit(1);
  }

  // Wrangler Versions cannot apply a new Durable Object class migration to an existing Worker.
  // Inspect the active migration tag after the build has produced the exact config, but before
  // remote database migration or secret mutation. First deployments remain supported.
  const lifecycleConfigPath = (
    deps.resolveGeneratedConfigPath ??
    ((projectRoot) => readGeneratedDeployConfig(projectRoot).path)
  )(root);
  if (atomic && !Array.isArray(parseRootWranglerConfig(lifecycleConfigPath).migrations)) {
    log.error(
      'deploy: atomic deployment is only for Workers with Durable Object migration history.',
    );
    return exit(1);
  }
  try {
    deduplicateGeneratedCompatibilityFlags(lifecycleConfigPath, configPath);
    await (deps.assertDurableObjectLifecycle ?? assertCloudflareDurableObjectLifecycleSupported)({
      runWrangler,
      configPath: lifecycleConfigPath,
      workerName,
      accountId,
      apiBaseUrl,
      allowPendingAtomicMigration: atomic,
    });
  } catch (error) {
    log.error(getErrorMessage(error));
    return exit(1);
  }

  if (
    !(await validateCloudflarePostBuildEnv(
      root,
      configPath,
      accountId,
      apiBaseUrl,
      workerName,
      schemaFacts,
      authEnabled,
      existingWorker,
      approvedHandoffKv,
      deps,
      assertUploaderStillPinned,
    ))
  ) {
    return exit(1);
  }

  // 8c. Auth-schema check — the managed platform creates Void-managed Better Auth tables at
  // RUNTIME (POST /__void/migrate/auth) after dispatch; this self-host backend never calls it,
  // it only applies checked-in `db/migrations/*.sql`. So verify the checked-in migrations
  // PRODUCE the required Better Auth schema (tables + columns, incl. configured renames + plugin
  // tables) by reading the schema the BUILD generated (`.void/better-auth-schema.ts` — ground
  // truth) and applying the migrations to in-memory SQLite. PostgreSQL uses the same generated
  // schema as the drift gate below; applying its SQL to SQLite would be invalid, so only the D1
  // dialect needs this additional structural simulation.
  if (authEnabled && dialect === 'sqlite') {
    try {
      await (deps.validateAuthMigrations ?? validateAuthMigrationSchema)(root, migrations);
    } catch (err) {
      log.error(
        [
          'deploy: --platform cloudflare cannot verify the Void-managed Better Auth schema.',
          'The managed platform creates these tables at runtime (POST /__void/migrate/auth)',
          'after deploy; this self-host backend only applies checked-in db/migrations/*.sql, so',
          'they must already produce the Better Auth schema — tables, columns, and the primary',
          'keys, unique constraints and foreign keys it declares:',
          `  ${getErrorMessage(err)}`,
          ...(err instanceof SqliteMigrationError
            ? [
                'Repair the unapplied migration named above, then rerun deploy.',
                '`void db generate` diffs snapshots and cannot repair existing invalid SQL.',
              ]
            : [
                '`void db generate` includes the production Better Auth schema automatically.',
                'Run it, review and commit the generated migration, then rerun deploy.',
              ]),
        ].join('\n'),
      );
      return exit(1);
    }
  }

  // 8d. Local migration gates — run POST-build,
  // immediately before the remote apply, against the RE-COLLECTED post-build migrations. Moving
  // them here (from pre-build) closes the window where a build plugin could add/rewrite migration
  // SQL that step 9 would then apply to remote D1 ungated: `wrangler d1 migrations apply` reads
  // the live post-build files, and these gates now validate exactly that set. Nothing between the
  // build and here mutates remote state, so a failed gate never leaves a half-migrated account.
  let d1MigrateToken: string | undefined;
  if (desired.d1 || desired.hyperdrive) {
    // 8d-i. Run the SAME gates the managed deploy runs — schema drift, journal coherence,
    // destructive-op-without-pragma — for EVERY D1 app REGARDLESS of migration count. A
    // `db/schema.ts` with no generated migration is drift the old count-gated check silently
    // skipped (shipping a schemaless remote DB); wrangler also auto-applies destructive SQL in CI
    // (its confirmation defaults to "yes" non-interactively). `validateMigrations` self-guards on
    // an empty set.
    try {
      (deps.assertMigrationsDeployable ?? assertRemoteMigrationsDeployable)(
        root,
        dialect,
        migrationsDir,
        migrations,
      );
    } catch (err) {
      log.error(getErrorMessage(err));
      return exit(1);
    }

    // Resolve + validate the D1 migrate target ONLY when there ARE checked-in migrations: a D1
    // desired purely from DB-use or auth can have no `db/migrations`, and wrangler 4.131
    // HARD-FAILS `d1 migrations apply` on a missing/empty folder (it never no-ops).
    if (desired.d1 && migrations.length > 0) {
      // `migrations_dir` must be present in the config: wrangler defaults a missing value to
      // `./migrations` (relative to the config) and would apply an unrelated folder.
      const migrateConfig = parseRootWranglerConfig(configPath);
      const d1MigrationsDir = readStoredResourceName(
        migrateConfig,
        'd1_databases',
        desired.d1.binding,
        'migrations_dir',
      );
      if (!d1MigrationsDir) {
        log.error(
          [
            `deploy: D1 binding ${desired.d1.binding} has no "migrations_dir" in ${configPath}.`,
            'Refusing to run `wrangler d1 migrations apply` — wrangler would default to',
            '`./migrations` (relative to the config) and apply an unrelated folder to your',
            'remote database, or error. Automatic provisioning should have set this field;',
            'rerun `void deploy --platform cloudflare`, or add it yourself.',
          ].join('\n'),
        );
        return exit(1);
      }
      // wrangler 4.131 resolves the migrate target by FIRST-matching the passed token
      // against `database_name` OR `binding` (getDatabaseInfoFromConfig, src/d1/utils.ts)
      // and reads THAT entry's `migrations_dir`. The gate validated the entry matched by
      // BINDING, so migrate by a token that resolves to exactly that entry — fail closed
      // when an earlier alias entry would shadow it (else wrangler could migrate the wrong
      // DB / an unrelated folder though the gate passed).
      const migrateTarget = resolveD1MigrateTarget(migrateConfig, desired.d1.binding);
      if (!migrateTarget.ok) {
        log.error(
          [
            `deploy: cannot safely run D1 migrations for binding ${desired.d1.binding} — ${migrateTarget.reason}`,
            'wrangler resolves `d1 migrations apply <name>` by first-matching the name against',
            "each entry's database_name OR binding, so an ambiguous token could migrate a",
            'different database than the one validated. Give each D1 database a unique',
            'database_name (and binding), then rerun.',
          ].join('\n'),
        );
        return exit(1);
      }

      // 8d-iii. Pin check — the remote apply below resolves its target from THIS post-build
      // `migrateConfig` (the root config wrangler re-reads to map the token → database_id), so
      // assert that database_id still equals what was snapshotted at step 6 BEFORE the build.
      // A tampered build that rewrote `d1_databases[<binding>].database_id` — keeping the binding
      // + database_name so the token still resolves — would otherwise redirect this privileged
      // `--remote` migration to a DIFFERENT same-account database. Fail closed, mirroring the
      // account_id pin. A binding never pinned (no real id pre-build, which the drift check
      // already rejects) is not asserted.
      const { field: d1Field, idField: d1IdField } = DEPLOY_BINDING_IDENTITY_FIELDS.d1;
      const pinnedD1Id = bindingIdentitySnapshot.get(
        bindingIdentityKey(d1Field, desired.d1.binding),
      );
      const postBuildD1Id = readStoredResourceName(
        migrateConfig,
        d1Field,
        desired.d1.binding,
        d1IdField,
      );
      if (pinnedD1Id !== undefined && postBuildD1Id !== pinnedD1Id) {
        log.error(
          [
            `deploy: the ${desired.d1.binding} D1 database identity changed between validation and the remote migrate.`,
            `Refusing to run \`wrangler d1 migrations apply\` — the build rewrote ${d1IdField} in ${configPath}`,
            `(validated ${JSON.stringify(pinnedD1Id)}, now ${JSON.stringify(postBuildD1Id)}), which would redirect this`,
            'privileged remote migration to a different database. Rebuild from a clean checkout, then rerun.',
          ].join('\n'),
        );
        return exit(1);
      }

      // 8d-ii. The EXACT files wrangler will apply (its own `migrations_dir` + `migrations_pattern`
      // resolution) must EQUAL the gated source set by normalized name AND content. Otherwise
      // a stray/extra `.sql` (e.g. `seed.sql`, which the gate's `collectMigrations` skips but
      // wrangler's `*.sql` glob matches), a differing dir, or a divergent file would be applied
      // to REMOTE D1 unvalidated. The gate above only checked `migrations`; this makes the
      // applied set == the validated set.
      const applyCheck = await (deps.checkMigrationApplySet ?? checkWranglerMigrationApplySet)(
        configPath,
        migrateConfig,
        desired.d1.binding,
        d1MigrationsDir,
        migrations,
      );
      if (!applyCheck.ok) {
        log.error(applyCheck.reason);
        return exit(1);
      }
      d1MigrateToken = migrateTarget.token;
    }
  }

  const generatedConfigPath = (
    deps.resolveGeneratedConfigPath ?? resolveGeneratedDeployConfigPathDefault
  )(root);
  const prepareBuildOutput = () =>
    frameworkPreset?.cloudflareArtifact === 'worker-output'
      ? prepareCfFrameworkBuildOutput({
          projectRoot: root,
          configPath: generatedConfigPath,
          accountId,
        })
      : prepareCfBuildOutput(dirname(generatedConfigPath), accountId);
  if (!deps.activateVersion && !deps.runWrangler) {
    // Validate the exact upload format before changing a remote database or secret.
    const preflight = await prepareBuildOutput();
    if (!preflight) {
      log.error('deploy: cf could not prepare the built Worker for deployment.');
      return exit(1);
    }
    await preflight.dispose();
  }
  return { migrations, d1MigrateToken, generatedConfigPath, prepareBuildOutput };
}
