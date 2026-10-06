import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  CloudflareWorkerInspectionError,
  type ExistingCloudflareWorker,
} from '@void/deploy-cloudflare';
import { isCancel, select } from '@voidzero-dev/vite-plus-prompts';
import { isCI as ciInfoIsCI } from 'ci-info';
import {
  CloudflareAuthenticationError,
  cloudflareCredentialOverrides,
  ensureCloudflareAuthentication,
  parseCloudflareAuthSession,
} from './cloudflare-auth.ts';
import { prepareExistingCloudflareDeploy } from './cloudflare-link.ts';
import { createCloudflareProcessRunner } from './cloudflare-process.ts';
import { log } from './deploy-helpers.ts';
import {
  isCleanWranglerExit,
  CloudflareAuthSecretError,
  BETTER_AUTH_SECRET_NAME,
} from './deploy-resources.ts';
import { deployChildEnv } from './deploy-transport.ts';
import { type DeployWranglerRun, type DeployWranglerRunResult } from './deploy-types.ts';
import {
  listSelfHostSecretNames,
  SelfHostFirstDeployError,
  SelfHostSecretListError,
} from './env-validation.ts';
import { writeProvisionedWranglerConfig } from './wrangler.ts';

/** Run typed provider operations in the pinned account and API context. */
export function createDeployWranglerRunner(
  root: string,
  accountId: string | undefined,
  apiBaseUrl: string,
): DeployWranglerRun {
  const runner = createCloudflareProcessRunner({
    root,
    accountId,
    apiBaseUrl,
    env: () => deployChildEnv(accountId, apiBaseUrl),
  });
  return (operation, opts) => runner(operation, opts);
}

/** Retry an existing-Worker read only when a fresh identity check proves the session is gone. */
export async function prepareExistingCloudflareDeployWithAuth(
  options: Parameters<typeof prepareExistingCloudflareDeploy>[0],
  beforeRun: () => boolean,
): Promise<ExistingCloudflareWorker | null> {
  try {
    return await prepareExistingCloudflareDeploy(options);
  } catch (error) {
    if (!(error instanceof CloudflareWorkerInspectionError)) {
      throw error;
    }
    if (!beforeRun()) {
      throw new CloudflareAuthenticationError(
        'The Cloudflare uploader changed during Worker verification.',
        'uploader-changed',
      );
    }
    const configPath = existsSync(options.configPath) ? options.configPath : undefined;
    const identity = await options.runWrangler(
      { type: 'auth.whoami', configPath },
      { capture: true },
    );
    const session = isCleanWranglerExit(identity)
      ? parseCloudflareAuthSession(identity.data)
      : null;
    const wrongAccount =
      session !== null &&
      session.accounts.length > 0 &&
      !session.accounts.some((account) => account.id === options.accountId);
    if (session && !wrongAccount) {
      // Authentication works. Preserve the original Worker/permission error.
      throw error;
    }
    const loggedOut = (identity.data as { loggedIn?: unknown } | undefined)?.loggedIn === false;
    const authenticationError =
      loggedOut ||
      wrongAccount ||
      /authentication is required|not authenticated|no api token|invalid.*token|expired.*token|unauthorized/i.test(
        identity.stderr,
      );
    if (!authenticationError || identity.signal || identity.error) {
      throw new Error(
        'Could not verify the Cloudflare session after the Worker check failed. Run `void cloudflare status` and retry.',
      );
    }
    const overrides = cloudflareCredentialOverrides();
    if (overrides.length > 0) {
      throw new Error(
        `Cloudflare credentials from ${overrides.join(', ')} were rejected or cannot access account ${options.accountId}. Correct or unset them, then retry the deploy.`,
      );
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        wrongAccount
          ? `The Cloudflare session cannot access account ${options.accountId}. Run \`void cloudflare login\` with the correct user, or set a token for that account in CI, then retry.`
          : 'Cloudflare authentication expired or is unavailable. Run `void cloudflare login` in a terminal, or set CLOUDFLARE_API_TOKEN in CI, then retry.',
      );
    }
    log.warn(
      wrongAccount
        ? 'The current Cloudflare session cannot access the deployment account. Signing in before retrying the Worker check.'
        : 'Cloudflare session is unavailable. Signing in before retrying the Worker check.',
    );
    const authenticated = await ensureCloudflareAuthentication({
      forceLogin: true,
      requireAccounts: true,
      beforeRun,
      runWrangler: (operation, capture) => options.runWrangler(operation, { capture }),
      configPath,
    });
    if (!authenticated.accounts.some((account) => account.id === options.accountId)) {
      throw new Error(
        `The signed-in Cloudflare user cannot access account ${options.accountId}. Sign in with a user who can access it, then retry.`,
      );
    }
    if (!beforeRun()) {
      throw new CloudflareAuthenticationError(
        'The Cloudflare uploader changed during sign-in.',
        'uploader-changed',
      );
    }
    return await prepareExistingCloudflareDeploy(options);
  }
}

export async function chooseCloudflareDeployAccount(options: {
  persist?: boolean;
  beforeWranglerRun: () => boolean;
  configPath: string;
  root: string;
  runWrangler: DeployWranglerRun;
}): Promise<string> {
  const session = await ensureCloudflareAuthentication({
    beforeRun: options.beforeWranglerRun,
    requireAccounts: true,
    runWrangler: (operation, capture) => options.runWrangler(operation, { capture }),
    configPath: existsSync(options.configPath) ? options.configPath : undefined,
  });
  const accounts = session.accounts;
  let account = accounts[0]!;
  if (accounts.length > 1) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        'Multiple Cloudflare accounts are available. Set CLOUDFLARE_ACCOUNT_ID in CI, or run `void init` interactively to choose one.',
      );
    }
    const accountId = await select({
      message: 'Choose a Cloudflare account:',
      initialValue: account.id,
      options: accounts.map((candidate) => ({
        value: candidate.id,
        label: candidate.name,
        hint: candidate.id,
      })),
    });
    if (isCancel(accountId) || typeof accountId === 'symbol') {
      throw new Error('Cloudflare account selection was cancelled.');
    }
    account = accounts.find((candidate) => candidate.id === accountId) ?? account;
  }
  if (options.persist !== false) {
    writeProvisionedWranglerConfig(
      options.root,
      { accountId: account.id },
      { configPath: options.configPath },
    );
  }
  log.success(`Configured Cloudflare account: ${account.name}`);
  return account.id;
}

/**
 * wrangler's own interactivity gate (`isNonInteractiveOrCI`, workers-utils): `ci-info`'s `isCI`
 * OR either stdio not a TTY. The email step (3b-ii) uses THIS rather than the deploy's `isCI`
 * (stdin-only, or a CI token source): wrangler asks its own y/n on a destructive `addresses`
 * plan change after the upload under the same gate, and the two halves of one deploy must call
 * the same run interactive — otherwise Void would prompt where wrangler then throws in "CI", or
 * skip a prompt wrangler goes on to ask.
 */
export function isWranglerNonInteractiveOrCI(): boolean {
  return ciInfoIsCI || !(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Borrow the wrangler session's bearer for the two email calls wrangler has no command for
 * (0078 "The flow, by lane": subdomain routing enable, the subaddressing PATCH, plus the
 * read-only zone classification). Spawns `wrangler auth token --json` through the deploy runner
 * — the pinned uploader, the pinned account + API base — with `WRANGLER_WRITE_LOGS=false`
 * layered on the child env: without it wrangler appends the token to
 * `~/.wrangler/logs/wrangler-*.log`, mode `-rw-r--r--` (`shouldLogToDisk`). The captured stdout
 * is parsed and the token string is handed to the caller's closure ONLY: it is never logged,
 * never placed in `process.env` or any later child env, and never part of an error — every
 * failure resolves `null`, which the email module reports as "session bearer unavailable".
 */
export async function runWranglerAuthToken(
  runWrangler: DeployWranglerRun,
  configPath: string,
): Promise<string | null> {
  let result: DeployWranglerRunResult;
  try {
    result = await Promise.resolve(
      runWrangler(
        { type: 'auth.token', configPath },
        {
          capture: true,
          env: { WRANGLER_WRITE_LOGS: 'false' },
        },
      ),
    );
  } catch {
    return null;
  }
  if (!isCleanWranglerExit(result)) {
    return null;
  }
  const parsed = result.data as { type?: unknown; token?: unknown } | null | undefined;
  // An `api_key` session answers `{ key, email }` — there is no single bearer to borrow.
  const type = parsed?.type;
  const token = parsed?.token;
  return (type === 'oauth' || type === 'api_token') && typeof token === 'string' && token.length > 0
    ? token
    : null;
}

/**
 * Ensure an auth-enabled worker has one persistent Better Auth secret.
 *
 * Existing remote secrets are adopted unchanged. A missing secret is generated
 * once, streamed to `wrangler secret put` over stdin (never argv), then verified
 * by listing names again. A not-yet-deployed Worker is the one safe list failure
 * treated as absence because Wrangler can attach a secret to its draft Worker.
 */
export async function ensureCloudflareAuthSecret(options: {
  root: string;
  configPath: string;
  accountId?: string;
  workerName: string;
  runWrangler: DeployWranglerRun;
  beforeWranglerRun?: () => boolean;
}): Promise<{ created: boolean; workerWasMissing?: true; candidateSecret?: string }> {
  let workerWasMissing = false;
  const beforeRun = (): void => {
    if (options.beforeWranglerRun && !options.beforeWranglerRun()) {
      throw new CloudflareAuthSecretError('', 'uploader-changed');
    }
  };
  const list = async (allowMissingWorker: boolean): Promise<Array<string>> => {
    beforeRun();
    try {
      return await listSelfHostSecretNames(
        {
          root: options.root,
          configPath: options.configPath,
          accountId: options.accountId,
          workerName: options.workerName,
          runWrangler: (args) => options.runWrangler(args, { capture: true }),
        },
        [BETTER_AUTH_SECRET_NAME],
      );
    } catch (error) {
      if (allowMissingWorker && error instanceof SelfHostFirstDeployError) {
        workerWasMissing = true;
        return [];
      }
      if (error instanceof SelfHostSecretListError) {
        throw new CloudflareAuthSecretError(
          `deploy: could not confirm the remote ${BETTER_AUTH_SECRET_NAME}. ` +
            'No worker was uploaded. Run `void secret list` to diagnose the Cloudflare response, then retry.',
          allowMissingWorker ? 'list-failed' : 'verification-failed',
        );
      }
      throw error;
    }
  };

  const existing = await list(true);
  if (existing.includes(BETTER_AUTH_SECRET_NAME)) {
    return { created: false };
  }

  const secret = randomBytes(32).toString('hex');
  if (workerWasMissing) {
    // cf uploads secrets with the initial Worker version. The API's standalone
    // secret endpoints reject a Worker that has not been created yet.
    return { created: true, workerWasMissing: true, candidateSecret: secret };
  }
  beforeRun();
  let put: DeployWranglerRunResult;
  try {
    put = await Promise.resolve(
      options.runWrangler(
        {
          type: 'secret.put',
          name: BETTER_AUTH_SECRET_NAME,
          configPath: options.configPath,
          workerName: options.workerName,
        },
        { capture: true, input: `${secret}\n` },
      ),
    );
  } catch {
    throw new CloudflareAuthSecretError(
      `deploy: could not create the remote ${BETTER_AUTH_SECRET_NAME}. ` +
        `No worker was uploaded. Run \`void secret put ${BETTER_AUTH_SECRET_NAME}\` and retry.`,
      'put-failed',
    );
  }
  if (!isCleanWranglerExit(put)) {
    throw new CloudflareAuthSecretError(
      `deploy: could not create the remote ${BETTER_AUTH_SECRET_NAME} ` +
        `(Cloudflare command exit ${String(put.status)}). No worker was uploaded. ` +
        `Run \`void secret put ${BETTER_AUTH_SECRET_NAME}\` and retry.`,
      'put-failed',
    );
  }

  const verified = await list(false);
  if (!verified.includes(BETTER_AUTH_SECRET_NAME)) {
    throw new CloudflareAuthSecretError(
      `deploy: Cloudflare reported success but ${BETTER_AUTH_SECRET_NAME} was not present afterward. ` +
        'No worker was uploaded; retry once Cloudflare secret storage is available.',
      'verification-failed',
    );
  }
  return { created: true };
}
