import { existsSync } from 'node:fs';
import {
  parseRootWranglerConfig,
  readStoredResourceName,
  readWranglerTopLevelString,
  assertExistingCloudflareConfig,
  type ExistingCloudflareWorker,
  type ApprovedCloudflareKvBinding,
} from '@void/deploy-cloudflare';
import { confirm, isCancel } from '@voidzero-dev/vite-plus-prompts';
import { dirname, relative } from 'pathslash';
import { analyzeApplicationSync, type ApplicationAnalysis } from '../application-analysis.ts';
import { resolveBindingNames, type VoidConfig } from '../config.ts';
import { detectFramework } from '../plugin-inference.ts';
import type { EmailHandlersScan } from '../router/email.ts';
import { assertSandboxNamespaceConfig, resolveSandboxConfig } from '../sandbox/config.ts';
import { ensureCloudflareAuthentication } from './cloudflare-auth.ts';
import { classifyCloudflareDeployApp } from './cloudflare-deploy/classify.ts';
import { approvedCloudflareIsrBinding, chooseCloudflareIsr } from './cloudflare-isr.ts';
import { readCloudflareLink, type CloudflareLink } from './cloudflare-link.ts';
import { resolveCloudflareWorkersDevSubdomain } from './cloudflare-readiness.ts';
import { resolveEnvSchemaFactsDefault } from './deploy-artifact-validation.ts';
import {
  deepEqual,
  snapshotBindingIdentities,
  snapshotPassthroughIdentities,
  snapshotPassthroughRawFields,
  reconstructExpectedContainers,
  reconstructExpectedDurableObjectState,
} from './deploy-binding-snapshot.ts';
import {
  createDeployWranglerRunner,
  chooseCloudflareDeployAccount,
  isWranglerNonInteractiveOrCI,
  prepareExistingCloudflareDeployWithAuth,
} from './deploy-cloudflare-auth.ts';
import { hasVoidSendEmailBinding, runCloudflareEmailStep } from './deploy-cloudflare-email.ts';
import {
  createCloudflareUploaderPins,
  discoverRootWranglerConfig,
  logCloudflareAuthFailure,
} from './deploy-cloudflare-helpers.ts';
import { log, getErrorMessage } from './deploy-helpers.ts';
import {
  resolveWranglerMigrationPattern,
  formatCloudflareDriftMessage,
} from './deploy-migrations.ts';
import { loadProvisionModule } from './deploy-provision.ts';
import {
  computeDesiredCloudflareResources,
  deriveWorkerName,
  isCleanWranglerExit,
  formatCloudflareSandboxUnavailable,
  CLOUDFLARE_RESOURCE_LABELS,
} from './deploy-resources.ts';
import { printDeployContext } from './deploy-summary.ts';
import { resolveDeployTransport, buildSchemaProbeEnv } from './deploy-transport.ts';
import {
  type RunDeployOptions,
  type CloudflareDeployDeps,
  type EmailAddressMapInput,
} from './deploy-types.ts';
import { createNodeEmailDns, SEND_EMAIL_BINDING } from './email-cloudflare.ts';
import type { EnvSchemaProbeResult } from './env-schema-probe.ts';
import { selfHostSchemaFailureMessage, type SelfHostSchemaFacts } from './env-validation.ts';
import { type CliLogger } from './log-file.ts';
// The provision module pulls in the whole-provision cross-process lock
// (`proper-lockfile` → `signal-exit`), which patches `process.emit` /
// `process.reallyExit` and installs exit handlers the moment it is imported. An
// ordinary MANAGED `void deploy` never enters the Cloudflare-backend fork, so it
// must not pay that side effect. Keep ONLY erasable `import type` at module scope
// and load the runtime values with a DYNAMIC `import()` inside the fork
// (`loadProvisionModule`), so importing this file (which `cli.ts` does for every
// deploy) never evaluates the provision lifecycle.
import type { ProvisionDriftEntry } from './provision.ts';
import { writeProvisionedWranglerConfig } from './wrangler.ts';

/** Validate source-level native deploy inputs before account operations or project code. */
export async function prepareCloudflareDeploySource(
  root: string,
  options: RunDeployOptions,
  voidConfig: VoidConfig,
): Promise<
  ({ configPath: string } & Awaited<ReturnType<typeof computeDesiredCloudflareResources>>) | null
> {
  // 0. Flag guard — `--skip-build` cannot be honored by this backend, so REJECT the
  // combination rather than silently ignore it. Every gate on this path reads the artifact
  // `vite build` emits as ground truth: the plaintext-var warnings, the required-secret gate
  // and the invalid-value gate all read the REAL `dist/ssr/wrangler.json`, and the auth check
  // reads the generated `.void/better-auth-schema.ts`. Skipping the build would leave them
  // validating a stale or absent artifact — i.e. reporting a worker that is not the one being
  // uploaded. Rejected here, before any account op, so the flag can never cost a build hook.
  if (options.skipBuild) {
    log.error(
      [
        'deploy: --skip-build is not supported with --platform cloudflare.',
        'This backend validates the artifact the build emits — the worker vars in',
        'dist/ssr/wrangler.json and the generated auth schema — so a skipped build would',
        'leave every check reading a stale or missing artifact instead of the worker you',
        'are about to upload. Drop --skip-build, or deploy with `void deploy` (the managed',
        'platform), which supports it.',
      ].join('\n'),
    );
    return null;
  }

  // 1. App-class narrowing — reject every artifact shape the current native
  // verifier cannot prove safe before any account, provision, or build op.
  let application: ApplicationAnalysis;
  try {
    application = analyzeApplicationSync(root, { config: voidConfig, environment: 'prod' });
  } catch (error) {
    log.error(`deploy: ${getErrorMessage(error)}`);
    return null;
  }
  const classification = classifyCloudflareDeployApp(root, voidConfig, options, application);
  if (!classification.supported) {
    log.error(classification.reason);
    return null;
  }

  // 2. Desired resource set — computed ONCE from SOURCE, pre-build (fail-fast),
  // shared by the provision and drift paths. `authEnabled` / `migrationsDir` /
  // `dialect` drive the auth + migration gates below. The checked-in migrations are
  // deliberately NOT read here: the auth + migration gates re-collect them AFTER the
  // build (see step 8), because `vite build` runs arbitrary project plugins that could
  // add/rewrite migration SQL, and the remote apply reads the live post-build files.
  const configPath = discoverRootWranglerConfig(root);
  const facts = await computeDesiredCloudflareResources(root, voidConfig, configPath, application);
  const { desired, dialect, migrations: preBuildMigrations, migrationsDir } = facts;

  // 2a. External-database migrations are applied directly after every local gate
  // passes and immediately before the Worker upload. A checked-in migration therefore requires
  // the production DATABASE_URL in the deploy environment; the URL is also the source used when
  // provisioning a missing Hyperdrive config and is never serialized into the Worker artifact.
  if (dialect !== 'sqlite' && preBuildMigrations.length > 0 && !process.env.DATABASE_URL) {
    log.error(
      [
        `deploy: ${dialect === 'mysql' ? 'MySQL' : 'PostgreSQL'} migrations require DATABASE_URL for --platform cloudflare.`,
        'Set the production connection string in the deploy environment. Void uses it only to',
        'provision Hyperdrive and apply checked-in migrations before uploading the Worker; it is',
        'never written to wrangler.jsonc or the generated Worker config.',
      ].join('\n'),
    );
    return null;
  }

  // 2b. Validate Wrangler's migration glob before any account operation. Custom patterns are
  // supported, but they must follow Wrangler's migrations_dir prefix rule; the post-build gate
  // later enumerates the exact Minimatch result and requires byte-for-byte set and order parity
  // with Void's validated migrations before any remote D1 mutation.
  if (desired.d1) {
    const migrationsPattern = resolveWranglerMigrationPattern(
      parseRootWranglerConfig(configPath),
      desired.d1.binding,
      desired.d1.migrationsDir ?? relative(dirname(configPath), migrationsDir),
    );
    if (!migrationsPattern.ok) {
      log.error(migrationsPattern.reason);
      return null;
    }
  }

  return { configPath, ...facts };
}

export async function preflightCloudflareWorker(input: {
  readonly configPath: string;
  readonly needsSandbox: boolean;
  readonly voidConfig: VoidConfig;
  readonly root: string;
  readonly exit: (code: number) => never;
  readonly deps: CloudflareDeployDeps;
  readonly options: RunDeployOptions;
  readonly initialCloudflareLink: CloudflareLink | null;
  readonly needsEmail: boolean;
  readonly emailHandlers: EmailHandlersScan;
  readonly authEnabled: boolean;
  readonly needsAI: boolean;
  readonly expectedCrons: Array<string>;
  readonly desired: import('./provision.ts').DesiredResourceSet;
  readonly preBuildMigrations: Array<{ name: string; sql: string }>;
  readonly provisionModule: Awaited<ReturnType<typeof loadProvisionModule>>;
  readonly reasons: Map<string, string>;
  readonly cliLog: CliLogger;
  readonly detectedFramework: ReturnType<typeof detectFramework>;
  readonly source: NonNullable<Awaited<ReturnType<typeof prepareCloudflareDeploySource>>>;
  readonly needsLive: boolean;
}): Promise<{
  apiBaseUrl: string;
  cfUploaderIsPinned: () => boolean;
  assertUploaderStillPinned: () => boolean;
  accountId: string;
  workersDevSubdomain: string | undefined;
  runWrangler: NonNullable<CloudflareDeployDeps['runWrangler']>;
  workerName: string;
  emailMap: EmailAddressMapInput | null;
  schemaFacts: SelfHostSchemaFacts;
  existingWorker: ExistingCloudflareWorker | null;
  pinnedHandoffLink: CloudflareLink | null;
  approvedHandoffKv: Array<ApprovedCloudflareKvBinding>;
  bindingIdentitySnapshot: ReturnType<typeof snapshotBindingIdentities>;
  passthroughIdentitySnapshot: ReturnType<typeof snapshotPassthroughIdentities>;
  passthroughRawFields: ReturnType<typeof snapshotPassthroughRawFields>;
  expectedContainers: ReturnType<typeof reconstructExpectedContainers>;
  expectedDurableObjectState: ReturnType<typeof reconstructExpectedDurableObjectState>;
}> {
  const {
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
  } = input;

  let rootConfig = parseRootWranglerConfig(configPath);
  if (needsSandbox) {
    try {
      assertSandboxNamespaceConfig(rootConfig, resolveSandboxConfig(voidConfig, root));
    } catch (error) {
      log.error(`deploy: ${getErrorMessage(error)}`);
      return exit(1);
    }
  }

  // 3a. Resolve + pin the ONE transport for the WHOLE deploy (build + whoami + migrate +
  // deploy), reusing the provisioner's resolver + dotenv fence. Fail closed on any
  // ambient/dotenv redirect (endpoint, named env, worker-name override, alternate
  // build config) BEFORE any wrangler call — so every child shares one account + API base.
  let apiBaseUrl: string;
  try {
    apiBaseUrl = resolveDeployTransport(root, rootConfig);
  } catch (err) {
    log.error(`deploy: ${getErrorMessage(err)}`);
    return exit(1);
  }

  // Pin the bundled uploader before the first authenticated command, including
  // first-run account discovery.
  const { cfUploaderIsPinned, assertUploaderStillPinned } = createCloudflareUploaderPins(
    root,
    deps,
  );

  // 3b. Pin the account. On an interactive first deploy Void authenticates,
  // selects the account, and persists it without exposing Wrangler as a user step.
  let accountId =
    readWranglerTopLevelString(rootConfig, 'account_id') ??
    (process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || undefined);
  if (!accountId) {
    const accountRunner =
      deps.runWrangler ?? createDeployWranglerRunner(root, undefined, apiBaseUrl);
    try {
      accountId = await chooseCloudflareDeployAccount({
        persist: !(options.reuseExistingWorker || initialCloudflareLink),
        beforeWranglerRun: assertUploaderStillPinned,
        configPath,
        root,
        runWrangler: accountRunner,
      });
      rootConfig = parseRootWranglerConfig(configPath);
    } catch (error) {
      logCloudflareAuthFailure(error);
      return exit(1);
    }
  }
  let workersDevSubdomain: string | undefined;
  try {
    workersDevSubdomain = resolveCloudflareWorkersDevSubdomain(root, accountId);
  } catch (error) {
    log.error(getErrorMessage(error));
    return exit(1);
  }

  // The orchestrator's own wrangler runner — created here, after the account is pinned and before
  // the FIRST credentialed run of the email step below; shared by whoami / provision probes / migrate / deploy.
  const runWrangler = deps.runWrangler ?? createDeployWranglerRunner(root, accountId, apiBaseUrl);
  // The worker name `wrangler deploy` uploads as: the root's `name`, else derived. Needed by the
  // email step (routing rules are matched to it) and reconciled into the root config at step 5.
  const workerName = readWranglerTopLevelString(rootConfig, 'name') ?? deriveWorkerName(root);
  printDeployContext(workerName, 'Cloudflare');

  // 3b-ii. Mode B email (design doc 0078) — detect, preflight, and with one Enter set up the
  // developer's own mail domain. Slotted AFTER the uploader hash (3b-i) and the account pin (3b), so its credentialed
  // wrangler runs execute the pinned bundle, and BEFORE the env-schema probe (3c), so no project
  // code has run when a credentialed call is made — and so `rootConfig` can simply be RE-PARSED
  // after the write: the post-probe laundering guard (the full-config `deepEqual` after 3c) then
  // sees `send_email` / `addresses` / `vars` as the pre-probe baseline and needs no exception.
  // Only `needsEmail` apps pay for it. The step stops every deploy for an ambiguous committed
  // subdomain plan waiting on DNS; otherwise `--require-email` turns every "deploying without
  // email" branch into an exit BEFORE anything is built or uploaded.
  let emailMap: EmailAddressMapInput | null = null;
  if (needsEmail) {
    if (!assertUploaderStillPinned()) {
      return exit(1);
    }
    const email = await runCloudflareEmailStep({
      root,
      configPath,
      voidConfig,
      rootConfig,
      handlers: emailHandlers,
      workerName,
      accountId,
      apiBaseUrl,
      runWrangler,
      nonInteractive: deps.isCI ?? isWranglerNonInteractiveOrCI(),
      confirm:
        deps.confirmEmailSetup ??
        (async (message) => {
          const answer = await confirm({ message, initialValue: true });
          return !isCancel(answer) && answer === true;
        }),
      fetchImpl: deps.emailFetch ?? fetch,
      dns: deps.emailDns ?? (await createNodeEmailDns()),
    });
    if (email.abortDeploy) {
      return exit(1);
    }
    if (options.requireEmail && !email.satisfied) {
      log.error(
        [
          'deploy: --require-email — email is not fully set up for this deploy (see above); refusing to deploy.',
          'Nothing was built or uploaded. Set email up, or drop --require-email.',
        ].join('\n'),
      );
      return exit(1);
    }
    if (email.configWritten) {
      rootConfig = parseRootWranglerConfig(configPath);
    }
    emailMap = email.map;
  } else {
    // The app stopped using email, but the root still carries what a Mode B deploy wrote.
    // wrangler keeps those rules pointed at a worker that no longer exports `email()`, so
    // inbound mail there fails with nothing in this output — say so. Warn only: deleting the
    // key would ORPHAN the live rules (wrangler skips the plan on `undefined`), and `[]` is
    // a destructive plan (a y/n in a TTY, a UserError after the upload in CI) — whether Void
    // should write it is a product call, not a deploy default (decision 11: never a failure).
    const staleAddresses = Array.isArray(rootConfig.addresses)
      ? (rootConfig.addresses as Array<unknown>).filter((a): a is string => typeof a === 'string')
      : [];
    const staleBinding = hasVoidSendEmailBinding(rootConfig);
    if (staleAddresses.length > 0 || staleBinding) {
      log.warn(
        [
          'deploy: this app no longer declares email handlers or imports void/email, but the Cloudflare config still carries the email setup Void wrote:',
          ...staleAddresses.map(
            (a) =>
              `  • ${a} — still routed to worker "${workerName}", which no longer exports email(); inbound mail there will fail.`,
          ),
          ...(staleBinding ? [`  • send_email ${SEND_EMAIL_BINDING} binding`] : []),
          'Deploying as-is. To detach: remove `addresses`, `send_email`, and `vars.__VOID_EMAIL_FROM` from `resolved` in void.lock.json (and any authored overrides in void.config.ts), then delete the rules in the Cloudflare dashboard (Email → Email Routing → Routing rules).',
        ].join('\n'),
      );
    }
  }

  // 3c. Derive the env-INSENSITIVE server and required key names in an ISOLATED
  // SUBPROCESS under a scrubbed env. Importing the user's env.ts is arbitrary project
  // code, so it must not run in this credential-bearing parent. Run before provisioning/building so a
  // broken env.ts fails fast.
  const schemaProbeEnv = buildSchemaProbeEnv(accountId, apiBaseUrl);
  let schemaResult: EnvSchemaProbeResult;
  try {
    schemaResult = await (deps.resolveSchemaFacts ?? resolveEnvSchemaFactsDefault)(
      { root },
      schemaProbeEnv,
    );
  } catch (err) {
    log.error(`deploy: could not derive the env schema — ${getErrorMessage(err)}`);
    return exit(1);
  }
  if (schemaResult.kind === 'schema-error') {
    log.error(`deploy: ${selfHostSchemaFailureMessage(schemaResult.reason)}`);
    return exit(1);
  }
  const schemaFacts: SelfHostSchemaFacts = schemaResult.facts;

  // The schema probe above imports project code. Its child has no Cloudflare credentials, but it
  // can still rewrite files — including the root Wrangler config that every authenticated command
  // below consumes. Compare the full parsed config with the pre-probe value before `whoami` or the
  // provisioner gets a chance to run. This placement cleanly distinguishes an illicit probe write
  // from the provisioner's legitimate id/migrations_dir updates, so automatic provisioning does
  // not create a laundering exception. Formatting-only JSONC rewrites remain harmless because the
  // comparison is semantic and key-order-independent.
  if (!deepEqual(rootConfig, parseRootWranglerConfig(configPath))) {
    log.error(
      [
        'deploy: the root wrangler config changed during the pre-build env-schema probe.',
        'Refusing to run an authenticated Cloudflare command with a config rewritten by project',
        'code. Rebuild from a clean checkout, then rerun.',
      ].join('\n'),
    );
    return exit(1);
  }

  // 3e. Confirm wrangler auth. `whoami` gets the SAME `-c`/`--env=`/pinned-transport
  // context as migrate/deploy, so it authenticates against the exact endpoint they use.
  // Re-verify the uploader immediately before this credentialed run — the env-schema probe above
  // ran project code (env.ts) that could have overwritten the hashed bundle `whoami` executes.
  if (!assertUploaderStillPinned()) {
    return exit(1);
  }
  try {
    await ensureCloudflareAuthentication({
      acceptApiToken: true,
      beforeRun: assertUploaderStillPinned,
      runWrangler: (operation, capture) => runWrangler(operation, { capture }),
      configPath: existsSync(configPath) ? configPath : undefined,
    });
  } catch (error) {
    logCloudflareAuthFailure(error);
    return exit(1);
  }

  let existingWorker: ExistingCloudflareWorker | null = null;
  let pinnedHandoffLink: CloudflareLink | null = null;
  let approvedHandoffKv: Array<ApprovedCloudflareKvBinding> = [];
  if (options.reuseExistingWorker || initialCloudflareLink) {
    if (
      authEnabled ||
      needsSandbox ||
      needsAI ||
      expectedCrons.length ||
      desired.queues.length ||
      preBuildMigrations.length
    ) {
      throw new Error(
        'Link the existing site without adding runtime features, auth setup, or database migrations. Make those changes in a later deployment.',
      );
    }
    approvedHandoffKv = approvedCloudflareIsrBinding(voidConfig, rootConfig);
    existingWorker = await prepareExistingCloudflareDeployWithAuth(
      {
        root,
        configPath,
        accountId,
        reuse: options.reuseExistingWorker,
        pinnedLink: initialCloudflareLink,
        runWrangler,
        readExistingWorker: deps.readExistingWorker,
        approvedKv: approvedHandoffKv,
      },
      assertUploaderStillPinned,
    );
    pinnedHandoffLink = readCloudflareLink(root);
    if (!pinnedHandoffLink) {
      throw new Error('The pending Cloudflare handoff was not saved before deployment.');
    }
    rootConfig = parseRootWranglerConfig(configPath);

    // Resolve the cache choice now. The saved source setting applies to retries and
    // ordinary deploys, so completing the handoff never changes the app's cache policy.
    const isrNamespace = desired.kvNamespaces.find(
      (namespace) => namespace.binding === 'ISR_CACHE',
    );
    if (
      existingWorker &&
      !existingWorker.bindings.some((binding) => binding.name === 'ISR_CACHE') &&
      resolveBindingNames(voidConfig.inference?.bindings)?.kv !== 'ISR_CACHE' &&
      isrNamespace
    ) {
      const missing = provisionModule
        .checkCloudflareProvisionDrift(configPath, desired)
        .missing.filter((entry) => entry.binding !== 'ISR_CACHE');
      if (missing.length) {
        throw new Error(
          formatCloudflareDriftMessage(
            missing,
            reasons,
            'Linking cannot provision these inferred resources:',
            'Keep new application resources separate from this migration.',
          ),
        );
      }
      const enabled = await chooseCloudflareIsr(root, voidConfig, {
        interactive: !(deps.isCI ?? isWranglerNonInteractiveOrCI()),
        confirm: deps.confirmIsrSetup,
      });
      if (!enabled) {
        desired.kvNamespaces = desired.kvNamespaces.filter(
          (namespace) => namespace.binding !== 'ISR_CACHE',
        );
      } else {
        if (approvedHandoffKv.length === 0) {
          if (!assertUploaderStillPinned()) {
            return exit(1);
          }
          await (deps.provision ?? provisionModule.provisionCloudflareResources)(
            root,
            configPath,
            {
              kvNamespaces: [isrNamespace],
              queues: [],
            },
            {
              accountId,
              log: { info: (message) => log.info(message), warn: (message) => log.warn(message) },
            },
          );
          rootConfig = parseRootWranglerConfig(configPath);
          approvedHandoffKv = approvedCloudflareIsrBinding(voidConfig, rootConfig);
          if (approvedHandoffKv.length !== 1) {
            throw new Error(
              'ISR setup did not record a valid cache namespace. Rerun `void deploy` to retry.',
            );
          }
        }
        assertExistingCloudflareConfig(existingWorker, rootConfig, false, approvedHandoffKv);
      }
      cliLog.info('cloudflare_handoff_isr_choice', { enabled });
    }
  }

  // 3f. Sandbox is the one public Void feature whose native Cloudflare runtime has a hard
  // Workers Paid dependency: `void/sandbox` emits a Cloudflare Container application. Verify the
  // account entitlement + the active credential BEFORE provisioning any inferred resources or
  // running the project build. `containers list --json` is a read-only account probe and succeeds
  // even when the account has no existing containers. Its failure surface deliberately conflates
  // a missing Workers Paid entitlement with insufficient API-token permissions, so the diagnostic
  // explains both remedies instead of guessing from a 403. Apps that do not use Sandbox never run
  // this probe and retain a Workers Free-compatible deploy path.
  if (needsSandbox) {
    if (!assertUploaderStillPinned()) {
      return exit(1);
    }
    const containers = await Promise.resolve(
      runWrangler(
        {
          type: 'containers.list',
          configPath: existsSync(configPath) ? configPath : undefined,
        },
        { capture: true },
      ),
    );
    if (!isCleanWranglerExit(containers)) {
      log.error(formatCloudflareSandboxUnavailable({ preflight: true }));
      return exit(1);
    }
    cliLog.info('cloudflare_sandbox_available');
  }

  // Whether the root config's D1 migrations_dir differs from the source-derived directory.
  const d1MigrationsDirDiffers = (): boolean =>
    desired.d1 != null &&
    readStoredResourceName(
      parseRootWranglerConfig(configPath),
      'd1_databases',
      desired.d1.binding,
      'migrations_dir',
    ) !== desired.d1.migrationsDir;

  // 4. Ensure every inferred resource exists. Missing id-bearing bindings trigger this
  // immediately; queues are probed below and trigger it when absent. `--provision` remains a
  // backwards-compatible force switch, but normal local and CI deploys need no extra command.
  // The provisioner is read-first and idempotent, and its local lock/config postconditions remain
  // the single authority for resource creation.
  const provisionAndVerify = async (): Promise<void> => {
    if (existingWorker) {
      const { missing } = provisionModule.checkCloudflareProvisionDrift(configPath, desired);
      throw new Error(
        missing.length > 0
          ? formatCloudflareDriftMessage(
              missing,
              reasons,
              'Linking cannot provision these inferred resources:',
              `Check the existing Worker's binding names and resource IDs in void.config.ts and inference.bindings there, then rerun \`void deploy\`. Keep new resources for a later deployment.`,
            )
          : 'Linking cannot provision resources. Remove --provision and rerun `void deploy` to reuse the existing Worker.',
      );
    }
    // Re-verify the uploader immediately before the credentialed provisioner, which runs
    // `wrangler <res> create` with the CF token. Nothing between `whoami` and here runs project
    // code, so this is defense-in-depth against the same probe-swap vector — against the one
    // pre-probe baseline, never re-baselined.
    if (!assertUploaderStillPinned()) {
      return exit(1);
    }
    const provision = deps.provision ?? provisionModule.provisionCloudflareResources;
    let result;
    try {
      result = await provision(root, configPath, desired, {
        accountId,
        log: { info: (msg) => log.info(msg), warn: (msg) => log.warn(msg) },
      });
      cliLog.info('cloudflare_provisioned', {
        resources: result.resources.map((r) => `${r.kind}:${r.action}`),
      });
    } catch (err) {
      log.error(`deploy: provisioning failed — ${getErrorMessage(err)}`);
      return exit(1);
    }
    // A DESIRED resource the provisioner could not satisfy is FATAL, not success.
    // Hyperdrive returns action "skipped" when there is no connection source and
    // nothing adoptable — deploying past that would ship a worker with no HYPERDRIVE
    // binding that fails on its first DB request. Fail closed with guidance.
    const skipped = result.resources.filter((r) => r.action === 'skipped');
    if (skipped.length > 0) {
      log.error(
        [
          'deploy: these required resources were skipped during provisioning and are NOT available:',
          ...skipped.map((r) => {
            const label =
              CLOUDFLARE_RESOURCE_LABELS[r.kind as ProvisionDriftEntry['kind']] ?? r.kind;
            return `  • ${r.binding ?? r.name} (${label})${r.reason ? ` — ${r.reason}` : ''}`;
          }),
          'Resolve the connection source (e.g. set DATABASE_URL for Hyperdrive, or adopt an',
          'existing config), then rerun. Nothing was built or deployed — but provisioning runs',
          'before this check, so any resource listed as created above already exists in your',
          'account (rerunning adopts it rather than duplicating it).',
        ].join('\n'),
      );
      return exit(1);
    }
    // Re-run the id-drift predicate AFTER provisioning: any desired id-bearing
    // resource the provisioner did not write a real id for still drifts and must
    // block the build/deploy (the desired set is the single source of truth).
    const { missing } = provisionModule.checkCloudflareProvisionDrift(configPath, desired);
    if (missing.length > 0) {
      log.error(
        formatCloudflareDriftMessage(
          missing,
          reasons,
          'deploy: provisioning did not satisfy every required resource:',
          'Retry `void deploy --platform cloudflare`, or provision the listed resources manually.',
        ),
      );
      return exit(1);
    }
    if (desired.d1 && d1MigrationsDirDiffers()) {
      log.error(
        `deploy: provisioning did not set migrations_dir for D1 binding ${desired.d1.binding}. Retry \`void deploy --platform cloudflare\`.`,
      );
      return exit(1);
    }
  };

  const { missing: initiallyMissing } = provisionModule.checkCloudflareProvisionDrift(
    configPath,
    desired,
  );
  // A handoff applies no migrations, so preserve the existing local migration settings.
  // Reconciling migrations_dir must not send an already-bound database to the provisioner.
  const d1NeedsConfigReconciliation = !existingWorker && d1MigrationsDirDiffers();
  if (options.provision || initiallyMissing.length > 0 || d1NeedsConfigReconciliation) {
    await provisionAndVerify();
  } else {
    // Queue names come from file paths (`queues/order/jobs.ts` → `order-jobs`, see
    // `queues/scan.ts`), and the probe below passes each one to wrangler as an ARGV positional.
    // Apart from joining path segments, names are not sanitized. Gate them on the SAME
    // `assertValidResourceName('queue', …)` the provisioner applies, BEFORE the probe runs:
    // a name beginning with `-` is
    // parsed by wrangler as a FLAG (`queues info --help` exits 0 printing usage), which the
    // probe would classify as inconclusive and wave through — silently forfeiting the
    // early-ordering guarantee this whole step exists to provide. Collect EVERY offending name
    // (as the drift/absent-queue errors do) so one rename pass clears them all.
    const invalidQueues = desired.queues.filter((name) => {
      try {
        provisionModule.assertValidResourceName('queue', name);
        return false;
      } catch {
        return true;
      }
    });
    if (invalidQueues.length > 0) {
      log.error(
        [
          'Deploy blocked — these queue names are not valid Cloudflare queue names:',
          ...invalidQueues.map((name) => `  • ${name} (queue)`),
          '',
          'A queue takes its name from its path in queues/; nested segments are joined with "-".',
          'A queue name must be 1–63 characters, contain only letters, digits and "-", and',
          'begin and end with a letter or digit.',
          '',
          'Rename the offending file(s) in queues/ and retry.',
        ].join('\n'),
      );
      return exit(1);
    }
    // The drift check above is config-only, and queues carry NO id in the config — so a
    // desired queue that was never created is invisible to it. `wrangler deploy` (step 11)
    // does reject a missing queue before uploading, but only AFTER the build (step 7) and
    // the remote D1 apply (step 9) have run. Probe each desired queue by name HERE so that
    // an absent queue can trigger the provisioner before either.
    //
    // `queues list` is unusable (a human table with no `--json`, whose single un-looped
    // page-1 request silently truncates on large accounts), so this is N `queues info`
    // calls — one clean binary probe per desired queue. Only the provisioner's exact,
    // name-aware not-found signal counts as absence: an inconclusive probe (auth or
    // network error, signal-killed child, unexpected output) must NOT block, since
    // `wrangler deploy`'s own pre-upload check still backstops it.
    const absentQueues: Array<string> = [];
    for (const name of desired.queues) {
      const info = await Promise.resolve(
        runWrangler({ type: 'queues.info', name, configPath }, { capture: true }),
      );
      if (provisionModule.isQueueConfirmedAbsent(info, name)) {
        absentQueues.push(name);
      }
    }
    if (absentQueues.length > 0) {
      await provisionAndVerify();
    }
  }

  // 5. Reconcile the worker `name` AND the pinned `account_id` into the root config
  // BEFORE the build. `name` is only-when-absent (never clobber the user's); the build
  // defaults a name into dist/ssr/wrangler.json, but `wrangler secret list -c <root>`
  // (the secrets gate) resolves the worker from the ROOT config's `name`, so pinning it
  // makes the gate and deploy agree. `account_id` is always overwritten with the
  // reconciled account: the CF Vite plugin copies `account_id` ONLY from the root config
  // file (never from CLOUDFLARE_ACCOUNT_ID) into dist/ssr/wrangler.json, so an env-only
  // pin would otherwise emit an artifact with NO `account_id` and the identity check
  // below could never confirm the pin. Persisting it makes the documented env-only pin
  // deploy the verified account. (`workerName` was resolved from the same root `name` before the
  // email step, which never touches it.)
  const frameworkQueues = detectedFramework ? source.analysis.queues : [];
  writeProvisionedWranglerConfig(
    root,
    {
      name: workerName,
      accountId,
      ...(detectedFramework
        ? {
            queues: {
              producers: frameworkQueues.map((queue) => ({
                queue: queue.name,
                binding: queue.bindingName,
              })),
              consumers: frameworkQueues.map((queue) => ({
                queue: queue.name,
                ...(queue.maxBatchSize != null && { max_batch_size: queue.maxBatchSize }),
                ...(queue.maxBatchTimeout != null && {
                  max_batch_timeout: queue.maxBatchTimeout,
                }),
                ...(queue.maxRetries != null && { max_retries: queue.maxRetries }),
                ...(queue.retryDelay != null && { retry_delay: queue.retryDelay }),
              })),
              reconcileVoidOwned: true,
            },
          }
        : {}),
    },
    { configPath },
  );

  // 6. Pin the id-bearing binding IDENTITIES across the build, mirroring the account_id pin.
  // Provision (step 4) wrote each real id into the root config via `wrangler <res> create
  // --update-config`, and the reconcile above only touches `name`/`account_id` — so RE-READING
  // the config here captures exactly what every legitimate PRE-BUILD write persisted. The build
  // (step 7) runs untrusted project code with its Cloudflare credentials scrubbed, so a
  // compromised build dependency can only edit FILES: it could rewrite `wrangler.jsonc`'s
  // `d1_databases[<binding>].database_id` (keeping the binding + database_name) to redirect the
  // privileged remote D1 migrate (step 9) or the deploy (step 11) to a DIFFERENT same-account
  // resource — OR ADD a brand-new id-bearing binding (`EXTRA_DB`/`EXTRA_KV`/…) the CF plugin then
  // merges verbatim into the emitted artifact. So the snapshot captures EVERY id-bearing binding
  // declared here, not only the desired ones: the emitted-config check (step 10) rejects any
  // id-bearing binding in `dist/ssr/wrangler.json` absent from this pin, so a binding the build
  // added is caught while a user's own extra binding (present here) passes. This snapshot is the
  // ground truth the migrate assert (step 9) and the emitted-config check (step 10) compare
  // against. No legitimate path rewrites a binding id in the ROOT config after this point — the
  // CF plugin's only post-build id writes go to the emitted dist/ssr/wrangler.json, never back to
  // the root — so equality here is safe to assert.
  const preBuildRootConfig = parseRootWranglerConfig(configPath);
  const bindingIdentitySnapshot = snapshotBindingIdentities(preBuildRootConfig);
  // Companion pin taken from the SAME pre-build root config: the per-binding ENTRY per resource
  // field Void's own build never emits (`DEPLOY_PASSTHROUGH_ASSERT_FIELDS`). The emitted-config
  // check (step 10) rejects any such binding in `dist/ssr/wrangler.json` absent from this pin — or
  // one whose target it rewrote — so a build that INJECTS or RETARGETS a `services` /
  // `secrets_store_secrets` / `dispatch_namespaces` / `unsafe` / … binding is caught, while a
  // user's own hand-declared pass-through binding (present here, unchanged) passes. Void never
  // writes these fields, so no legitimate build adds one that was not already in the root.
  const passthroughIdentitySnapshot = snapshotPassthroughIdentities(preBuildRootConfig);
  // Companion RAW-value pin from the SAME pre-build root config for the fields the ENTRY pin cannot
  // cover: `unsafe` / `tail_consumers` / `streaming_tail_consumers` (whole-object-pinned — wrangler
  // applies `unsafe.metadata` LAST at upload and the tail consumers forward logs/requests; the pin
  // is symmetric, so removing a root-declared value is caught too), plus `durable_objects` (reject a
  // build-injected EXTERNAL DO `script_name`) and `ai` (pin the binding to the root's, or to Void's
  // own `{binding:'AI'}` only when `needsAI`). Void's build emits none of the first three.
  const passthroughRawFields = snapshotPassthroughRawFields(preBuildRootConfig);
  // Companion pin: the exact `containers` set Void's build emits — the root-declared containers
  // (spread verbatim) plus Void's own sandbox container when the source needs it (`needsSandbox`,
  // the SAME `isSandboxEnabled(config) || import-walk` signal index.ts gates emission on). A bare
  // `wrangler deploy` provisions a container application from this array, so the emitted-config
  // check (step 10) rejects a container the build injected, dropped, or retargeted.
  // `resolveSandboxConfig` is the SAME pure function the build uses, so the reconstructed sandbox
  // container is byte-identical to the emitted one.
  const expectedContainers = reconstructExpectedContainers(
    voidConfig,
    root,
    preBuildRootConfig,
    needsSandbox,
  );
  const expectedDurableObjectState = reconstructExpectedDurableObjectState(
    voidConfig,
    root,
    preBuildRootConfig,
    { needsSandbox, needsLive, analysis: source.analysis },
  );
  return {
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
  };
}
