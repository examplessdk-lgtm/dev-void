import { spawnSync } from 'node:child_process';
import { cfAccessHeaders, isVoidAccessGatedUrl } from '../shared/cf-access.ts';
import { readKeyringPassword, writeKeyringPassword } from './keyring.ts';
import { normalizePlatformApiUrl, platformCredentialAccount } from './platform-registry.ts';

const ACCESS_KEYRING_SERVICE = 'dev.void.cli.access';
const keyringTokens = new Map<string, string | null>();

function usableToken(token: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof payload.exp === 'number' && payload.exp > Date.now() / 1000 + 60;
  } catch {
    return false;
  }
}

function rememberOriginToken(origin: string, token: string): void {
  let entries: Record<string, unknown> = {};
  if (process.env.VOID_ACCESS_CREDENTIALS) {
    const parsed = JSON.parse(process.env.VOID_ACCESS_CREDENTIALS) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        'platform: VOID_ACCESS_CREDENTIALS must contain an origin-keyed JSON object.',
      );
    }
    entries = parsed as Record<string, unknown>;
  }
  process.env.VOID_ACCESS_CREDENTIALS = JSON.stringify({
    ...entries,
    [origin]: { CF_ACCESS_TOKEN: token },
  });
}

function forgetOriginToken(origin: string): void {
  if (!process.env.VOID_ACCESS_CREDENTIALS) {
    return;
  }
  const parsed = JSON.parse(process.env.VOID_ACCESS_CREDENTIALS) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('platform: VOID_ACCESS_CREDENTIALS must contain an origin-keyed JSON object.');
  }
  const entries = { ...(parsed as Record<string, unknown>) };
  delete entries[origin];
  process.env.VOID_ACCESS_CREDENTIALS = JSON.stringify(entries);
}

export function isCloudflareAccessChallenge(response: Response): boolean {
  const location = response.headers.get('Location');
  if (!location || response.status < 300 || response.status >= 400) {
    return false;
  }
  try {
    const target = new URL(location);
    return (
      target.protocol === 'https:' &&
      !target.username &&
      !target.password &&
      /^[a-z0-9-]+\.cloudflareaccess\.com$/.test(target.hostname) &&
      target.pathname.startsWith('/cdn-cgi/access/login')
    );
  } catch {
    return false;
  }
}

/** Called for a selected origin, never for a redirect destination. */
export function ensurePlatformAccessToken(
  apiUrl: string,
  challenged = false,
  required = false,
  rejectedToken?: string,
): void {
  const origin = normalizePlatformApiUrl(apiUrl);
  if (!origin.startsWith('https://')) {
    return;
  }
  const headers = cfAccessHeaders(process.env, origin);
  if (headers['CF-Access-Client-Id']) {
    return;
  }
  if (!challenged && headers['cf-access-token'] && usableToken(headers['cf-access-token'])) {
    return;
  }
  const account = platformCredentialAccount(origin);
  if (!keyringTokens.has(origin)) {
    if (keyringTokens.size >= 64) {
      keyringTokens.delete(keyringTokens.keys().next().value!);
    }
    keyringTokens.set(origin, readKeyringPassword(ACCESS_KEYRING_SERVICE, account));
  }
  const stored = keyringTokens.get(origin);
  if (!challenged && stored && usableToken(stored)) {
    rememberOriginToken(origin, stored);
    return;
  }
  if (!challenged && !required && !stored && !headers['cf-access-token']) {
    return;
  }
  const rejectedTokens = new Set(
    [headers['cf-access-token'], stored, rejectedToken].filter(
      (token): token is string => typeof token === 'string' && token.length > 0,
    ),
  );
  if (challenged && rejectedTokens.size > 0) {
    forgetOriginToken(origin);
    keyringTokens.set(origin, null);
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        `platform: Cloudflare Access rejected the cached credential for ${origin}. Re-run this command in an interactive terminal to renew it.`,
      );
    }
    console.error(`Renew Cloudflare Access authentication for ${origin}.`);
    runCloudflared(['access', 'login', origin], { inherit: true, timeoutMs: 120_000 });
  }
  let token = runCloudflared(['access', 'token', `-app=${origin}`]);
  if (token && rejectedTokens.has(token)) {
    token = null;
  }
  if ((!token || !usableToken(token)) && process.stdin.isTTY && process.stdout.isTTY) {
    console.error(`Authenticate to Cloudflare Access for ${origin}.`);
    runCloudflared(['access', 'login', origin], { inherit: true, timeoutMs: 120_000 });
    token = runCloudflared(['access', 'token', `-app=${origin}`]);
  }
  if (!token || !usableToken(token)) {
    throw new Error(
      'platform: Cloudflare Access authentication is required. Install cloudflared and sign in interactively, or set VOID_ACCESS_ORIGIN with scoped CF_ACCESS_CLIENT_ID/CF_ACCESS_CLIENT_SECRET credentials for CI.',
    );
  }
  rememberOriginToken(origin, token);
  keyringTokens.set(origin, token);
  // Keychain failure keeps the credential only in process memory, never in a plaintext file.
  writeKeyringPassword(ACCESS_KEYRING_SERVICE, account, token);
}

const probedHosts = new Set<string>();

/**
 * If the CLI is about to talk to a Cloudflare-Access-gated staging host,
 * probe the locally-installed `cloudflared` binary for a cached user JWT
 * and export it as `CF_ACCESS_TOKEN`. On interactive shells with no cached
 * token, open a browser login flow to populate the cache, then re-read it.
 *
 * Cached per-host so that an early non-gated call (e.g. prod) does not
 * permanently disable the probe for a later gated call (e.g. staging) in
 * the same process. Noop when:
 *   - a service-token pair is already set (CI path)
 *   - `CF_ACCESS_TOKEN` is already set (manual override or prior probe)
 *   - the target host is not gated
 *   - `cloudflared` is not installed
 */
export function ensureCloudflaredToken(apiUrl: string): void {
  if (
    !isVoidAccessGatedUrl(apiUrl) ||
    process.env.VOID_ACCESS_ORIGIN ||
    process.env.VOID_ACCESS_CREDENTIALS
  ) {
    ensurePlatformAccessToken(apiUrl);
    return;
  }
  if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
    return;
  }
  if (process.env.CF_ACCESS_TOKEN) {
    return;
  }
  if (!isVoidAccessGatedUrl(apiUrl)) {
    return;
  }
  const host = new URL(apiUrl).hostname;
  if (probedHosts.has(host)) {
    return;
  }
  probedHosts.add(host);

  let token = runCloudflared(['access', 'token', `-app=${apiUrl}`]);

  if (!token && process.stdin.isTTY && process.stdout.isTTY) {
    // No cached token and we can show a browser prompt — kick off login.
    // `cloudflared access login` opens the browser and blocks until the
    // user completes the Access flow (or times out).
    runCloudflared(['access', 'login', apiUrl], { inherit: true, timeoutMs: 120_000 });
    token = runCloudflared(['access', 'token', `-app=${apiUrl}`]);
  }

  if (token) {
    process.env.CF_ACCESS_TOKEN = token;
  }
}

function runCloudflared(
  args: Array<string>,
  opts?: { inherit?: boolean; timeoutMs?: number },
): string | null {
  try {
    const result = spawnSync('cloudflared', args, {
      encoding: 'utf-8',
      stdio: opts?.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      timeout: opts?.timeoutMs ?? 5_000,
    });
    if (result.error || result.status !== 0) {
      return null;
    }
    const out = (result.stdout ?? '').trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** A protected API and proxy have separate audiences and separately scoped credentials. */
export function ensurePlatformProxyAccess(apiUrl: string, proxyUrl: string): void {
  ensurePlatformAccessToken(apiUrl);
  ensurePlatformAccessToken(
    proxyUrl,
    false,
    Object.keys(cfAccessHeaders(process.env, apiUrl)).length > 0,
  );
}
