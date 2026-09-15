import { spawnSync } from 'node:child_process';
import { log } from '@clack/prompts';
import { resolveWranglerArgv } from './preset.ts';

export type CloudflareAccount = Readonly<{
  id: string;
  name: string;
}>;

export type CloudflareAuthRunResult = Readonly<{
  status: number | null;
  stderr: string;
  stdout: string;
  signal?: NodeJS.Signals | null;
  error?: string | null;
}>;

export type CloudflareAuthRunner = (
  args: ReadonlyArray<string>,
  capture: boolean,
) => CloudflareAuthRunResult | Promise<CloudflareAuthRunResult>;

export type CloudflareAuthSession = Readonly<{
  accounts: ReadonlyArray<CloudflareAccount>;
}>;

export type EnsureCloudflareAuthenticationOptions = Readonly<{
  /**
   * Treat an explicit API token as sufficient for a pinned, non-discovery operation.
   * The operation itself remains the authoritative permission and validity check.
   */
  acceptApiToken?: boolean;
  beforeRun?: () => boolean;
  interactive?: boolean;
  /** Require whoami JSON to contain at least one account (account onboarding). */
  requireAccounts?: boolean;
  runWrangler: CloudflareAuthRunner;
  whoamiArgs?: ReadonlyArray<string>;
}>;

export class CloudflareAuthenticationError extends Error {
  override name = 'CloudflareAuthenticationError';
  readonly reason: 'keyring' | 'login' | 'not-authenticated' | 'uploader-changed';

  constructor(message: string, reason: CloudflareAuthenticationError['reason']) {
    super(message);
    this.reason = reason;
  }
}

/**
 * Authenticate with Cloudflare through Void's bundled deployment tooling.
 *
 * The caller owns the runner so deploy can retain its pinned account, API base,
 * config, and uploader-integrity boundary. Interactive sessions recover from an
 * expired or missing OAuth session in-process; CI remains token-only.
 */
export async function ensureCloudflareAuthentication(
  options: EnsureCloudflareAuthenticationOptions,
): Promise<CloudflareAuthSession> {
  if (
    options.acceptApiToken &&
    !options.requireAccounts &&
    (process.env.CLOUDFLARE_API_TOKEN?.trim() || process.env.CF_API_TOKEN?.trim())
  ) {
    return { accounts: [] };
  }
  const run = async (
    args: ReadonlyArray<string>,
    capture: boolean,
  ): Promise<CloudflareAuthRunResult> => {
    if (options.beforeRun && !options.beforeRun()) {
      throw new CloudflareAuthenticationError('', 'uploader-changed');
    }
    return await options.runWrangler(args, capture);
  };
  const whoamiArgs = ['whoami', '--json', ...(options.whoamiArgs ?? [])];
  const readSession = async (): Promise<CloudflareAuthSession | null> => {
    const result = await run(whoamiArgs, true);
    if (!isCleanExit(result)) {
      return null;
    }
    const accounts = parseCloudflareAccounts(result.stdout);
    if (options.requireAccounts) {
      return accounts && accounts.length > 0 ? { accounts } : null;
    }
    // Credentialed deploy commands only need Wrangler's clean exit. Keeping
    // account parsing optional also tolerates older Wrangler JSON shapes.
    return { accounts: accounts ?? [] };
  };

  const existing = await readSession();
  if (existing) {
    return existing;
  }

  const interactive = options.interactive ?? (process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    throw new CloudflareAuthenticationError(
      'Cloudflare authentication is required. Set CLOUDFLARE_API_TOKEN in CI, or run `void cloudflare login` in an interactive terminal.',
      'not-authenticated',
    );
  }

  const keyring = await run(['auth', 'keyring', 'enable'], true);
  if (!isCleanExit(keyring)) {
    throw new CloudflareAuthenticationError(
      'Void could not enable secure Cloudflare credential storage in your operating-system keychain.',
      'keyring',
    );
  }

  announceCloudflareLogin();
  const login = await run(['login', '--use-keyring'], true);
  if (!isCleanExit(login)) {
    throw new CloudflareAuthenticationError(
      'Cloudflare browser sign-in did not complete. Run `void cloudflare login` to try again.',
      'login',
    );
  }

  const authenticated = await readSession();
  if (!authenticated) {
    throw new CloudflareAuthenticationError(
      'Cloudflare sign-in completed without a usable session. Run `void cloudflare login` to try again.',
      'not-authenticated',
    );
  }
  return authenticated;
}

export function parseCloudflareAccounts(stdout: string): Array<CloudflareAccount> | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.loggedIn !== true || !Array.isArray(record.accounts)) {
    return null;
  }

  const accounts: Array<CloudflareAccount> = [];
  for (const account of record.accounts) {
    if (!account || typeof account !== 'object' || Array.isArray(account)) {
      continue;
    }
    const item = account as Record<string, unknown>;
    if (typeof item.id !== 'string' || item.id.length === 0) {
      continue;
    }
    accounts.push({
      id: item.id,
      name:
        typeof item.name === 'string' && item.name.length > 0 ? item.name : 'Cloudflare account',
    });
  }
  return accounts;
}

export function createBundledCloudflareAuthRunner(root: string): CloudflareAuthRunner {
  const [command, ...prefix] = resolveWranglerArgv(root);
  return (args, capture) => {
    const env = cloudflareAuthCommandEnvironment(args);
    const result = spawnSync(command!, [...prefix, ...args], {
      cwd: root,
      encoding: 'utf8',
      env,
      maxBuffer: 10 * 1024 * 1024,
      shell: false,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      timeout: 10 * 60 * 1000,
      windowsHide: true,
    });
    return {
      status: result.status,
      stderr: capture ? result.stderr || '' : '',
      stdout: capture ? result.stdout || '' : '',
      signal: result.signal,
      error: result.error?.message,
    };
  };
}

export function cloudflareAuthCommandEnvironment(
  args: ReadonlyArray<string>,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = cloudflareAuthEnvironment(source);
  if (args[0] === 'login' || args[0] === 'logout') {
    env.WRANGLER_LOG = 'none';
  }
  return env;
}

export function cloudflareAuthEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...source };
  const scrubbedWranglerKeys = new Set([
    'WRANGLER_OUTPUT_FILE_DIRECTORY',
    'WRANGLER_OUTPUT_FILE_PATH',
    'WRANGLER_LOG_SANITIZE',
  ]);
  for (const key of Object.keys(env)) {
    if (
      /^VOID_PLATFORM_/i.test(key) ||
      /^(?:DATABASE_URL|CF_ACCESS_CLIENT_ID|CF_ACCESS_CLIENT_SECRET|CF_ACCESS_TOKEN)$/i.test(key) ||
      scrubbedWranglerKeys.has(key.toUpperCase())
    ) {
      delete env[key];
    }
  }
  env.CLOUDFLARE_AUTH_USE_KEYRING = 'true';
  env.WRANGLER_LOG_SANITIZE = 'true';
  return env;
}

function isCleanExit(result: CloudflareAuthRunResult): boolean {
  return (
    result.status === 0 && result.signal == null && (result.error == null || result.error === '')
  );
}

export function announceCloudflareLogin(): void {
  log.info('Opening Cloudflare login in your browser. Press Ctrl+C to cancel.');
}
