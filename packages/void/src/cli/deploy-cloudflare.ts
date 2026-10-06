import { readConfig, isNodeTarget } from '../config.ts';
import { detectFramework } from '../plugin-inference.ts';
import { readCloudflareCandidate } from './cloudflare-candidate.ts';
import { readCloudflareLink } from './cloudflare-link.ts';
import {
  hasConfiguredVoidWorkerRoutingRules,
  removeDeployPointer,
} from './deploy-artifact-validation.ts';
import { buildCloudflareWorker } from './deploy-cloudflare-build.ts';
import { migrateCloudflareWorker } from './deploy-cloudflare-migrate.ts';
import {
  prepareCloudflareDeploySource,
  preflightCloudflareWorker,
} from './deploy-cloudflare-preflight.ts';
import { publishCloudflareWorker } from './deploy-cloudflare-publish.ts';
import {
  resolveCloudflareStaticPreset,
  resolveCloudflareVoidStaticPreset,
  runCloudflareStaticDeploy,
} from './deploy-cloudflare-static.ts';
import { log } from './deploy-helpers.ts';
import { loadProvisionModule } from './deploy-provision.ts';
import { printDeploySuccess } from './deploy-summary.ts';
import { type RunDeployOptions, type CloudflareDeployDeps } from './deploy-types.ts';
import { renderAddressMap } from './email-cloudflare.ts';
import { type CliLogger } from './log-file.ts';
import { FRAMEWORK_PRESETS } from './preset.ts';

/** Deploy to the user's own Cloudflare account through the guarded native Worker flow. */
export async function runCloudflareDeploy(
  root: string,
  options: RunDeployOptions,
  cliLog: CliLogger,
  deps: CloudflareDeployDeps = {},
): Promise<void> {
  const initialCloudflareLink = readCloudflareLink(root);
  const initialCloudflareCandidate = readCloudflareCandidate(root);
  const exit = deps.exit ?? ((code: number): never => process.exit(code));
  const voidConfig = readConfig(root);
  const atomic = options.atomic === true || voidConfig.deploy?.cloudflare?.mode === 'atomic';
  if (atomic && (options.reuseExistingWorker || initialCloudflareLink)) {
    log.error(
      'deploy: atomic deployment is unavailable during the existing Worker handoff. Complete the handoff first.',
    );
    return exit(1);
  }
  const detectedFramework = detectFramework(root);
  const frameworkPreset = detectedFramework ? FRAMEWORK_PRESETS[detectedFramework.name] : undefined;
  cliLog.info('cloudflare_deploy_start', {
    provision: options.provision === true ? true : undefined,
  });

  // Static deploys branch before the full Worker classifier, so keep the
  // runtime-target guard ahead of both paths. An explicit Cloudflare deploy
  // must never reinterpret a node/bun/deno project as a Workers Assets app.
  if (isNodeTarget(voidConfig.target)) {
    log.error(
      [
        `deploy: --platform cloudflare is not supported for the "${voidConfig.target}" target.`,
        'This backend deploys Cloudflare Workers only. Deploy a node/bun/deno build with its',
        'own host/runtime, or use the default Cloudflare target for --platform cloudflare.',
      ].join('\n'),
    );
    return exit(1);
  }

  if (detectedFramework?.class === 'a' && hasConfiguredVoidWorkerRoutingRules(voidConfig.routing)) {
    log.error(
      [
        `deploy: native Cloudflare deployment cannot apply Void routing redirects, rewrites, fallbacks, or headers to ${detectedFramework.name}.`,
        'This framework owns its Worker request handler, so these rules would otherwise be ignored.',
        'Move the rules into the framework or its Cloudflare Worker, then retry.',
      ].join('\n'),
    );
    return exit(1);
  }

  const provisionModule = await loadProvisionModule();
  const staticPreset =
    resolveCloudflareStaticPreset(root, voidConfig, options) ??
    (await resolveCloudflareVoidStaticPreset(root, voidConfig));
  if (staticPreset) {
    if (atomic) {
      log.error('deploy: atomic deployment is only for Workers with Durable Objects.');
      return exit(1);
    }
    return runCloudflareStaticDeploy(
      root,
      options,
      voidConfig,
      staticPreset,
      cliLog,
      deps,
      initialCloudflareLink,
      initialCloudflareCandidate,
    );
  }

  const source = await prepareCloudflareDeploySource(root, options, voidConfig);
  if (!source) {
    return exit(1);
  }
  const {
    configPath,
    desired,
    reasons,
    authEnabled,
    dialect,
    migrationsDir,
    migrations: preBuildMigrations,
    needsAI,
    aiBindingName,
    needsSandbox,
    needsLive,
    expectedCrons,
    needsEmail,
    emailHandlers,
  } = source;

  // 3. Preflight — pin ONE transport, pin the account, confirm wrangler auth. `rootConfig` is the
  // pre-probe ground truth the post-probe laundering guard (after 3c) compares against; the ONLY
  // re-parses are the account discovery's (3b) and the email step's (3b-ii), both of which write
  // BEFORE any project code runs.
  const {
    apiBaseUrl,
    cfUploaderIsPinned,
    assertUploaderStillPinned,
    accountId,
    workersDevSubdomain,
    runWrangler,
    workerName,
    emailMap,
    schemaFacts,
    existingWorker,
    pinnedHandoffLink,
    approvedHandoffKv,
    bindingIdentitySnapshot,
    passthroughIdentitySnapshot,
    passthroughRawFields,
    expectedContainers,
    expectedDurableObjectState,
  } = await preflightCloudflareWorker({
    configPath,
    needsSandbox,
    voidConfig,
    root,
    exit,
    deps,
    options,
    initialCloudflareLink,
    needsEmail,
    emailHandlers,
    authEnabled,
    needsAI,
    expectedCrons,
    desired,
    preBuildMigrations,
    provisionModule,
    reasons,
    cliLog,
    detectedFramework,
    source,
    needsLive,
  });

  // (The LOCAL migration gates run POST-build at step 8d, immediately before the remote
  // apply — not here — so they validate the exact files on disk AFTER the build. See step 8d.)

  // 7. Build with the pinned deploy transport — WITHOUT VOID_DEPLOY_PROJECT_ID — so
  // self-host ISR emits and the CF plugin merges the wrangler.jsonc real ids into
  // dist/ssr/wrangler.json. `deployChildEnv` scrubs CLOUDFLARE_ENV +
  // CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH (and pins one account + API base), so the CF
  // plugin generates the pinned TOP-LEVEL config from the CANONICAL root wrangler config,
  // not a named-env / alternate-config one whose account/name/bindings could differ.
  //
  // The build runs BEFORE the secret / auth gates: the redesign validates the REAL artifact
  // the build emits (`dist/ssr/wrangler.json` `vars` + the generated auth schema) rather than
  // predicting it, so a missing secret / bad auth schema is caught AFTER the build — the
  // accepted trade-off for reading ground truth. No REMOTE mutation has happened yet (provision
  // ran earlier, but the remote D1 apply + deploy are still ahead), so a failed gate below
  // never leaves a half-migrated / half-deployed account.
  //
  // DELETE the CF plugin's deploy pointer (`.wrangler/deploy/config.json`) FIRST. The
  // plugin OVERWRITES it (never deletes) on each build, but ONLY when the CF Vite plugin
  // participates — a build that emits no worker artifact leaves a STALE pointer from a
  // previous run in place, and a bare `wrangler deploy` would follow it to an old
  // `dist/ssr/wrangler.json`. Removing it now means the reads below (which require the
  // pointer to exist) can only pass on a pointer THIS build re-created.
  removeDeployPointer(root);
  // `vite build` runs arbitrary project code — the user's config, every plugin, and env.ts
  // — and needs NO Cloudflare credential of its own (the CF plugin makes no authenticated
  // call from a build hook; Void's `remote: true` is a serve-only proxy to Void's own
  // platform, and build-time prerender/ISR runs on local Miniflare). So the build child gets
  // the same credential scrub as the probes, on the same rationale.
  //
  // Not a leak this can close: the CF plugin's `config` hook `loadEnv`s the project's own
  // `CLOUDFLARE_*` dotenv keys back into the child's `process.env`. Those values are already
  // on disk and readable by the build code either way — the scrub is about the credentials
  // the PARENT holds, which the project never had.
  const { migrations, d1MigrateToken, generatedConfigPath, prepareBuildOutput } =
    await buildCloudflareWorker({
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
    });

  // Remember whether a secret operation proved the Worker was absent before it wrote anything.
  // Wrangler creates an active placeholder version while attaching the first secret. The version
  // activator needs this proof to distinguish that placeholder from an existing application when
  // Cloudflare requires a one-time ordinary deploy for initial Durable Object migrations.
  const { workerWasMissingBeforeSecretProvisioning, initialAuthSecret, appliedMigrations } =
    await migrateCloudflareWorker({
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
    });

  // 11. Deploy the exact generated config verified above. Passing its absolute path
  // explicitly keeps the version upload AND the later trigger synchronization on the
  // same artifact. `versions upload` follows the deploy pointer on its own, but
  // `triggers deploy` does not; omitting `configPath` here would therefore upload the
  // generated cron/queue configuration and then synchronize triggers from the root
  // config, silently dropping generated Cron Triggers and queue consumers.
  //
  // Final uploader re-verification immediately before the deploy — the last and most privileged
  // credentialed run of the hashed bundle. Against the same pre-build baseline; fail closed.
  await publishCloudflareWorker({
    configPath,
    existingWorker,
    root,
    pinnedHandoffLink,
    initialCloudflareCandidate,
    accountId,
    workerName,
    deps,
    cfUploaderIsPinned,
    exit,
    prepareBuildOutput,
    apiBaseUrl,
    runWrangler,
    generatedConfigPath,
    assertUploaderStillPinned,
    schemaFacts,
    initialAuthSecret,
    approvedHandoffKv,
    migrations,
    workerWasMissingBeforeSecretProvisioning,
    workersDevSubdomain,
    atomic,
    cliLog,
    needsSandbox,
    appliedMigrations,
    d1MigrateToken,
    source,
    desired,
    detectedFramework,
  });
  // The address map — the one thing nobody can find today (0078). Printed whenever the worker
  // shipped with email set up; a run that went without email already said so at 3b-ii.
  if (emailMap) {
    log.message(renderAddressMap(emailMap));
  }
  printDeploySuccess();
}

export {
  discoverRootWranglerConfig,
  formatCloudflareActivationError,
} from './deploy-cloudflare-helpers.ts';
