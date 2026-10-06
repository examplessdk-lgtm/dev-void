import { readWranglerTopLevelString } from '@void/deploy-cloudflare';
import { join } from 'pathslash';
import { scanWranglerDotenvKeys } from '../shared/dotenv.ts';
import { CLOUDFLARE_DEPLOY_BUILD_ENV } from '../shared/env.ts';
import { WRANGLER_AUTH_CREDENTIAL_ENV_VARS } from '../shared/untrusted-env.ts';
import { CLOUDFLARE_PRESERVE_BINDINGS_BUILD_ENV } from '../shared/version-metadata.ts';
import { requireProvisionModule, loadedProvisionModule } from './deploy-provision.ts';

/**
 * Marks a build child as driven by a MANAGED `void deploy`.
 *
 * The platform resolves the asset routing policy out-of-band (`resolveAssetConfig`
 * → `manifest.assetConfig`) and applies it to the uploaded script, so settings the
 * Vite plugin cannot safely write into the built wrangler config — `routing.notFound`
 * for a Class A framework, which needs an `assets` policy Void does not own there —
 * are still honored on this path. `void:framework-build-wrapper` warns about exactly
 * those when this flag is ABSENT, i.e. on a self-hosted `vite build && wrangler deploy`.
 *
 * Passed through the CHILD env only (never `process.env`), the same way
 * `VOID_DEPLOY_PROJECT_ID` is, so it cannot leak into an unrelated child process or a
 * later `void dev` in the same shell.
 *
 * Deliberately NOT set by `runCloudflareDeploy` (`--platform cloudflare`): that flow
 * hands the built output to `wrangler deploy` against the user's own account and IS the
 * self-host path the warning is about. (It rejects framework SSR outright today, so no
 * Class A build reaches it either way.)
 */
export const MANAGED_DEPLOY_BUILD_ENV = { VOID_DEPLOY_BUILD: '1' } as const;

/** Remove managed-only build markers from an explicit native Cloudflare child. */
export function scrubManagedDeployBuildMarkers(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { deleteEnvVarCaseAware } = requireProvisionModule();
  deleteEnvVarCaseAware(env, 'VOID_DEPLOY_PROJECT_ID');
  deleteEnvVarCaseAware(env, CLOUDFLARE_PRESERVE_BINDINGS_BUILD_ENV);
  for (const name of Object.keys(MANAGED_DEPLOY_BUILD_ENV)) {
    deleteEnvVarCaseAware(env, name);
  }
  return env;
}

/**
 * Deploy-time env selectors that pin the WRONG worker/config out from under the
 * top-level config this flow provisions + preflights. Scrubbed from every child env
 * and fenced in the project dotenv (see below), on top of the provisioner's transport
 * scrub/fence which owns the endpoint-redirect + `CLOUDFLARE_ENV` vars:
 *   - `WRANGLER_CI_OVERRIDE_NAME` — wrangler 4.131 applies it AFTER config load
 *     (`mergeSharedConfigArgs` → `getCIOverrideName()`), REPLACING the upload name, so a
 *     bare `wrangler deploy` uploads a worker whose name the generated-config check never
 *     validated.
 *   - `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH` — the CF Vite plugin points the build at an
 *     ALTERNATE wrangler config, flattening a different binding set into
 *     `dist/ssr/wrangler.json`.
 */
const DEPLOY_CONFIG_OVERRIDE_ENV_VARS = [
  'WRANGLER_CI_OVERRIDE_NAME',
  'CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH',
] as const;

/**
 * The dotenv files wrangler 4.131 reloads into `process.env` (`override: true`) for
 * the orchestrator's `--env=` calls (`getDefaultEnvFiles("")`), so a repo dotenv here
 * would resurrect `WRANGLER_CI_OVERRIDE_NAME` at the DEPLOY step after the child-env
 * scrub removed it.
 */
const DEPLOY_WRANGLER_DOTENV_FILES = ['.env', '.env.local', '.env.', '.env..local'];

/**
 * The dotenv files Vite's `loadEnv(mode, …)` reads for a production `vite build`
 * (`.env`, `.env.local`, `.env.production`, `.env.production.local`), where the CF Vite
 * plugin picks up `CLOUDFLARE_ENV` / `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH` — a set
 * DISJOINT from wrangler's `--env=` files, so it is fenced separately for the build.
 */
const DEPLOY_VITE_DOTENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local'];

/**
 * FAIL CLOSED when the AMBIENT env selects a non-top-level worker/config for the
 * Cloudflare backend, which deploys the top-level environment of the canonical root
 * config ONLY. `CLOUDFLARE_ENV` picks a named env block (different account/name/bindings);
 * `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH` points the build at a different config. We refuse
 * rather than silently deploy a target the drift-check / provision never reasoned about.
 */
function assertNoAmbientConfigOverride(): void {
  const cloudflareEnv = process.env.CLOUDFLARE_ENV;
  if (typeof cloudflareEnv === 'string' && cloudflareEnv.trim().length > 0) {
    throw new Error(
      'CLOUDFLARE_ENV is set. --platform cloudflare deploys the TOP-LEVEL environment of ' +
        'your root wrangler config only (a named environment can carry a different account, ' +
        'worker name, or binding set). Unset CLOUDFLARE_ENV and retry.',
    );
  }
  const configPathOverride = process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH;
  if (typeof configPathOverride === 'string' && configPathOverride.trim().length > 0) {
    throw new Error(
      'CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH is set. --platform cloudflare builds from the ' +
        'canonical root wrangler config only. Unset it and retry.',
    );
  }
}

/**
 * FAIL CLOSED when the project's dotenv files declare a deploy-time config-override
 * selector. wrangler / Vite reload dotenv on every command, so a repo dotenv would
 * reintroduce a scrubbed var AFTER the child-env scrub — reselecting the upload worker
 * name (wrangler `--env=` files) or the build's wrangler config (Vite production files).
 * The provisioner's transport fence ({@link assertNoTransportRedirectInProjectDotenv})
 * owns `CLOUDFLARE_ENV` + the endpoint-redirect vars; this closes the deploy-specific
 * name/config-path selectors it does not cover, across BOTH consumers' file sets.
 * Exported for direct unit testing of the file-set + win32 case rule.
 */
export function assertNoConfigOverrideInProjectDotenv(
  root: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const caseInsensitive = platform === 'win32';
  const declaresAny = (file: string, names: ReadonlyArray<string>): string | undefined => {
    const rawKeys = scanWranglerDotenvKeys(join(root, file));
    const keys = caseInsensitive ? new Set([...rawKeys].map((key) => key.toLowerCase())) : rawKeys;
    return names.find((name) => keys.has(caseInsensitive ? name.toLowerCase() : name));
  };
  // WRANGLER_CI_OVERRIDE_NAME reaches the DEPLOY step via wrangler's `--env=` dotenv reload.
  for (const file of DEPLOY_WRANGLER_DOTENV_FILES) {
    if (declaresAny(file, ['WRANGLER_CI_OVERRIDE_NAME'])) {
      throw new Error(
        `the project file "${file}" sets WRANGLER_CI_OVERRIDE_NAME, which wrangler reloads on ` +
          `every command and applies AFTER config load to REPLACE the deployed worker name — so ` +
          `\`wrangler deploy\` would upload a worker whose name was never validated. Remove it from ` +
          `"${file}" (set it in your shell/CI only if you truly need a CI name override).`,
      );
    }
  }
  // CLOUDFLARE_ENV / CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH reach the BUILD via Vite's
  // production `loadEnv`, whose file set is disjoint from wrangler's `--env=` files.
  for (const file of DEPLOY_VITE_DOTENV_FILES) {
    const offender = declaresAny(file, ['CLOUDFLARE_ENV', 'CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH']);
    if (offender) {
      throw new Error(
        `the project file "${file}" sets ${offender}, which the Cloudflare Vite plugin reads at ` +
          `build time to select a named environment or an ALTERNATE wrangler config — flattening a ` +
          `different binding set into dist/ssr/wrangler.json than this deploy provisioned. Remove ` +
          `${offender} from "${file}".`,
      );
    }
  }
}

/**
 * Resolve + validate the ONE pinned transport for the whole deploy, and FAIL CLOSED
 * on any ambient/dotenv redirect that would move the target out from under the pinned
 * top-level config. Reuses the provisioner's resolver + dotenv fence so provision AND
 * the deploy tail (build / whoami / migrate / deploy) share one source of truth.
 * Returns the single resolved API base URL to pin into every child env.
 */
export function resolveDeployTransport(root: string, rootConfig: Record<string, unknown>): string {
  const provision = requireProvisionModule();
  assertNoAmbientConfigOverride();
  provision.assertNoTransportRedirectInProjectDotenv(root);
  assertNoConfigOverrideInProjectDotenv(root);
  return provision.resolvePinnedApiBaseUrl(
    process.env,
    readWranglerTopLevelString(rootConfig, 'compliance_region'),
  );
}

/**
 * Build a child env for an orchestrator-owned wrangler / build invocation. Reuses the
 * provisioner's {@link provisionEnv} (scrubs the CF Access pair + EVERY transport
 * selector incl. `CLOUDFLARE_ENV` + win32 case variants, pins ONE account + API base),
 * then scrubs the deploy-specific config-override selectors on top.
 *
 * This is the env {@link createDeployWranglerRunner} spawns `whoami` / `d1 migrations apply`
 * / `deploy` with, so it deliberately KEEPS the wrangler-auth credentials — only the
 * untrusted-code children layer {@link scrubWranglerAuthCredentials} on top. Exported so a
 * test can assert that directly.
 */
export function deployChildEnv(
  accountId: string | undefined,
  apiBaseUrl: string,
): NodeJS.ProcessEnv {
  const provision = requireProvisionModule();
  const env = provision.provisionEnv({ accountId, apiBaseUrl });
  for (const name of DEPLOY_CONFIG_OVERRIDE_ENV_VARS) {
    provision.deleteEnvVarCaseAware(env, name);
  }
  // Pin WRANGLER_LOG=log for the whole deploy so wrangler's `d1 migrations list` sentinels
  // ('No migrations to apply!' / 'Migrations to be applied:'), emitted at logger level
  // `log`, are NEVER suppressed by an ambient WRANGLER_LOG=none|error|warn|info — otherwise
  // a declined/partial apply prints no marker and the pending-check would pass open. The
  // canonical spelling is scrubbed case-aware FIRST so no mixed-case ambient value shadows
  // the pin on win32; `log` is wrangler's own default level, so normal output is unchanged.
  provision.deleteEnvVarCaseAware(env, 'WRANGLER_LOG');
  env.WRANGLER_LOG = 'log';
  // Void owns the browser OAuth lifecycle. Never allow Wrangler to fall back to
  // its plaintext credential file while a Void command is using that session.
  env.CLOUDFLARE_AUTH_USE_KEYRING = 'true';
  return env;
}

/**
 * Delete every {@link WRANGLER_AUTH_CREDENTIAL_ENV_VARS} entry from `env` IN PLACE and
 * return it, for a child that executes UNTRUSTED project code and needs no Cloudflare
 * credential of its own.
 *
 * The case-aware delete lives in the provision module, which ONLY the Cloudflare fork
 * loads (a managed deploy must not pay `proper-lockfile`'s import-time side effects). One
 * caller — `runDrizzleKitGenerate`, via the shared schema-drift check — also runs on the
 * MANAGED path, where that module is legitimately absent, so read the memoized handle
 * directly instead of {@link requireProvisionModule} (which throws when the fork never ran)
 * and fall back to the exact-case delete. That fallback IS the whole rule off win32 (POSIX
 * env keys are case-sensitive); the case-insensitive win32 sweep only matters for the
 * Cloudflare fork, and by the time either call site runs there the module is always loaded.
 */
export function scrubWranglerAuthCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const deleteVar =
    loadedProvisionModule?.deleteEnvVarCaseAware ??
    ((target: NodeJS.ProcessEnv, name: string): void => {
      delete target[name];
    });
  for (const name of WRANGLER_AUTH_CREDENTIAL_ENV_VARS) {
    deleteVar(env, name);
  }
  // These are not Wrangler credentials, but native Cloudflare builds do not
  // need either one: DATABASE_URL is consumed only by the parent-side
  // provision/migration steps, and VOID_TOKEN belongs to the managed target.
  deleteVar(env, 'DATABASE_URL');
  deleteVar(env, 'VOID_TOKEN');
  return env;
}

/**
 * Build the child env for the isolated env-schema probe. Starts from
 * {@link deployChildEnv} (CF Access + every transport selector scrubbed, one account +
 * API base pinned), then (1) scrubs the FULL wrangler-auth credential set case-aware —
 * the probe needs no credentials — and (2) pins `NODE_ENV=production` so the child
 * evaluates env.ts under the SAME environment the build uses (`vite build` sets
 * `NODE_ENV=production`), keeping the required-key set the probe derives identical to
 * the built worker's. Used by BOTH the pre-build facts probe and the post-build
 * `validate-emitted` probe.
 */
export function buildSchemaProbeEnv(accountId: string, apiBaseUrl: string): NodeJS.ProcessEnv {
  const env = scrubManagedDeployBuildMarkers(
    scrubWranglerAuthCredentials(deployChildEnv(accountId, apiBaseUrl)),
  );
  // Match the Cloudflare deploy build's dotenv boundary. Besides keeping a
  // schema conditioned on this internal marker consistent with the build,
  // this prevents an ambient case variant from shadowing the pinned value on
  // Windows.
  requireProvisionModule().deleteEnvVarCaseAware(env, CLOUDFLARE_DEPLOY_BUILD_ENV);
  env[CLOUDFLARE_DEPLOY_BUILD_ENV] = '1';
  // Scrub any ambient spelling first (case-aware on win32) so it cannot shadow the pin.
  requireProvisionModule().deleteEnvVarCaseAware(env, 'NODE_ENV');
  env.NODE_ENV = 'production';
  return env;
}
