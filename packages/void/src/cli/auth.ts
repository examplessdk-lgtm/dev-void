import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'pathslash';
import { cfAccessHeaders } from '../shared/cf-access.ts';
import { ensureCloudflaredToken } from './cf-access.ts';
import { deleteKeyringPassword, readKeyringPassword, writeKeyringPassword } from './keyring.ts';
import {
  getActivePlatformConnection,
  listPlatformConnections,
  normalizePlatformApiUrl,
  platformCredentialAccount,
} from './platform-registry.ts';
import { readProjectConfig, readProjectPlatformUrl } from './project.ts';

const CONFIG_DIR = join(homedir(), '.void');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const KEYRING_SERVICE = 'dev.void.cli';

// ---------------------------------------------------------------------------
// Keyring helpers — try/catch around `new Entry` for environments where the
// native addon fails at runtime (CI, Docker, SSH, etc.)
// ---------------------------------------------------------------------------

function keyringGet(account: string): string | null {
  return readKeyringPassword(KEYRING_SERVICE, account);
}

function keyringSet(account: string, password: string): boolean {
  return writeKeyringPassword(KEYRING_SERVICE, account, password);
}

function keyringDelete(account: string): boolean {
  return deleteKeyringPassword(KEYRING_SERVICE, account);
}

// ---------------------------------------------------------------------------
// Config file — non-sensitive fields only (api).
// Origin-scoped file credentials remain readable when a keychain is unavailable.
// ---------------------------------------------------------------------------

type Config = {
  tokens?: Record<string, string>;
  api?: string;
};

function readConfig(): Config {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function writeConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

function readOriginScopedToken(apiUrl: string, config: Config): string | null {
  const normalizedApiUrl = normalizePlatformApiUrl(apiUrl);
  const account = platformCredentialAccount(normalizedApiUrl);
  const keyringToken = keyringGet(account);
  if (keyringToken) {
    return keyringToken;
  }

  const fileToken = config.tokens?.[normalizedApiUrl];
  if (!fileToken) {
    return null;
  }
  if (keyringSet(account, fileToken)) {
    delete config.tokens![normalizedApiUrl];
    if (Object.keys(config.tokens!).length === 0) {
      delete config.tokens;
    }
    try {
      writeConfig(config);
    } catch {
      // Migration is best-effort; the file remains a usable fallback.
    }
  }
  return fileToken;
}

function connectedPlatform(apiUrl: string | null | undefined) {
  if (!apiUrl) {
    throw new Error('platform: No Void platform connected. Run `void connect <url>` first.');
  }
  const origin = normalizePlatformApiUrl(apiUrl);
  const connection = listPlatformConnections().find((entry) => entry.apiUrl === origin);
  if (!connection) {
    throw new Error(`platform: No connection to ${origin}. Run \`void connect ${origin}\` first.`);
  }
  return connection;
}

export function getSiteDomain(root: string = process.cwd()): string {
  const connection = connectedPlatform(getApiUrl(root));
  if (!connection.applicationDomain) {
    throw new Error(
      `platform: Missing application domain. Run \`void connect ${connection.apiUrl}\` to refresh the connection.`,
    );
  }
  return connection.applicationDomain;
}

/**
 * Read the deploy token.
 * Priority: origin-bound VOID_TOKEN > system keychain > migrated config.
 * Environment tokens must name their recipient with VOID_API_URL.
 */
export function getToken(root: string = process.cwd()): string | null {
  const envToken = process.env.VOID_TOKEN;
  let apiUrl: string;
  try {
    apiUrl = getApiUrl(root);
  } catch (error) {
    if (envToken) {
      throw error;
    }
    return null;
  }
  const config = readConfig();
  return readTokenForOrigin(apiUrl, config);
}

/** Account actions follow the selected connection, independently of application metadata. */
export function getAccountCredential(): { apiUrl: string; token: string | null } {
  const config = readConfig();
  const apiUrl = connectedPlatform(
    process.env.VOID_API_URL || getActivePlatformConnection()?.apiUrl,
  ).apiUrl;
  return {
    apiUrl,
    token: readTokenForOrigin(apiUrl, config),
  };
}

function readTokenForOrigin(apiUrl: string, config: Config): string | null {
  const envToken = process.env.VOID_TOKEN;
  if (envToken) {
    if (!process.env.VOID_API_URL) {
      throw new Error(
        'auth: Set VOID_API_URL alongside VOID_TOKEN to identify the connected platform that issued it.',
      );
    }
    const tokenOrigin = normalizePlatformApiUrl(process.env.VOID_API_URL);
    if (apiUrl !== tokenOrigin) {
      throw new Error(
        `auth: VOID_TOKEN is not bound to ${apiUrl}. Set VOID_API_URL to this platform's URL with its matching token, or unset VOID_TOKEN to use the saved login.`,
      );
    }
    return envToken;
  }
  return readOriginScopedToken(apiUrl, config);
}

export function getTokenSource(): 'ci' | 'manual' {
  return process.env.VOID_TOKEN ? 'ci' : 'manual';
}

export function saveToken(
  token: string,
  root: string = process.cwd(),
  dependencies: { keyringSet?: (account: string, password: string) => boolean } = {},
): void {
  savePlatformToken(token, getApiUrl(root), dependencies);
}

export function readPlatformToken(apiUrl: string): string | null {
  return readOriginScopedToken(apiUrl, readConfig());
}

export function savePlatformToken(
  token: string,
  origin: string,
  dependencies: { keyringSet?: (account: string, password: string) => boolean } = {},
): void {
  const apiUrl = normalizePlatformApiUrl(origin);
  const account = platformCredentialAccount(apiUrl);
  if ((dependencies.keyringSet ?? keyringSet)(account, token)) {
    return;
  }
  throw new Error(
    'auth: The system keychain is unavailable. Refusing to store your platform token in plaintext. Configure a system keychain, or set VOID_TOKEN from a secret manager in headless environments.',
  );
}

export function removeToken(root: string = process.cwd()): boolean {
  const apiUrl = normalizePlatformApiUrl(getApiUrl(root));
  const account = platformCredentialAccount(apiUrl);
  let removed = false;

  if (keyringDelete(account)) {
    removed = true;
  }
  try {
    const config = readConfig();
    let configChanged = false;
    if (config.tokens?.[apiUrl]) {
      delete config.tokens[apiUrl];
      if (Object.keys(config.tokens).length === 0) {
        delete config.tokens;
      }
      configChanged = true;
      removed = true;
    }
    if (configChanged) {
      writeConfig(config);
    }
  } catch {
    // ignore
  }

  return removed;
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function createCodeVerifier(): string {
  return base64Url(randomBytes(32));
}

export function createCodeChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest());
}

async function exchangeLoginCode(
  apiUrl: string,
  code: string,
  state: string,
  codeVerifier: string,
): Promise<string> {
  const base = apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`;
  ensureCloudflaredToken(apiUrl);
  const res = await fetch(new URL('auth/cli/token', base), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cfAccessHeaders(process.env, apiUrl) },
    body: JSON.stringify({
      code,
      state,
      code_verifier: codeVerifier,
    }),
    redirect: 'manual',
  });

  if (!res.ok) {
    throw new Error(`auth: Failed to exchange login code (${res.status}). Try logging in again.`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error('auth: Login code exchange returned an invalid response.');
  }

  if (
    !body ||
    typeof body !== 'object' ||
    !('token' in body) ||
    typeof body.token !== 'string' ||
    body.token.length === 0
  ) {
    throw new Error('auth: Login code exchange did not return a token.');
  }

  return body.token;
}

/** Environment and project selections must refer to a verified local connection. */
export function getApiUrl(root: string = process.cwd()): string {
  const projectApiUrl = readProjectPlatformUrl(root);
  if (readProjectConfig(root) && !projectApiUrl) {
    throw new Error(
      'platform: This project link has no platform URL. Run `void connect <url>`, then `void project link` to choose its destination.',
    );
  }
  return connectedPlatform(
    process.env.VOID_API_URL || projectApiUrl || getActivePlatformConnection()?.apiUrl,
  ).apiUrl;
}

export function getProxyUrl(root: string = process.cwd()): string {
  // The project file is repository-controlled and therefore cannot be trusted
  // to choose the origin that receives a user's platform credential. Resolve
  // the proxy from the selected API's trusted local registry entry instead.
  // VOID_PROXY_URL remains an explicit operator override for CI and recovery.
  const apiUrl = getApiUrl(root);
  if (process.env.VOID_PROXY_URL) {
    return normalizePlatformApiUrl(process.env.VOID_PROXY_URL);
  }

  const proxyUrl = listPlatformConnections().find(
    (connection) => connection.apiUrl === apiUrl,
  )?.proxyUrl;
  if (proxyUrl === null || proxyUrl === undefined) {
    throw new Error(
      `platform: No verified proxy is registered for ${apiUrl}. Reconnect with \`void connect ${apiUrl}\` or set VOID_PROXY_URL explicitly.`,
    );
  }
  return proxyUrl;
}

function page(title: string, message: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} - Void</title>
<style>:root{color-scheme:light dark}*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fafafa;color:#111}.card{text-align:center;padding:3rem}h1{font-size:1.5rem;font-weight:600;margin-bottom:.75rem}p{color:#666;font-size:1rem}@media (prefers-color-scheme:dark){body{background:#0a0a0a;color:#fafafa}p{color:#a3a3a3}}</style>
</head><body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

export function openBrowser(
  url: string,
  execFile: typeof import('node:child_process').execFile,
): void {
  // Launch via argv (execFile), never a shell: the URL is passed as a single
  // argument so shell metacharacters in it can't be interpreted as commands.
  const ignore = (): void => {};
  if (process.platform === 'win32') {
    // Avoid cmd.exe interpreting URL query separators such as & as shell commands.
    execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], ignore);
    return;
  }
  if (process.platform === 'darwin') {
    execFile('open', [url], ignore);
    return;
  }
  // Linux — including WSL2 where `xdg-open` typically has no usable handler.
  // Try `wslview` (wslu), then fall back to the Windows URL handler.
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    execFile('wslview', [url], (error) => {
      if (error) {
        execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], ignore);
      }
    });
    return;
  }
  execFile('xdg-open', [url], ignore);
}

/**
 * Start a local HTTP callback server, open the browser to a caller-built
 * authorize URL, and wait for the redirect back to `http://localhost:PORT/callback`.
 *
 * The server validates the `state` it appended to the callback URL against the
 * incoming request, then runs the caller's `finalize` hook INSIDE the request
 * handler (so the browser only ever sees the success page after the underlying
 * exchange/link actually succeeded). On finalize success it renders the success
 * HTML and resolves with finalize's return value; on finalize failure it
 * renders the same "could not complete" failure page the login flow uses and
 * rejects with the thrown error. The server is always closed before settling.
 *
 * `onUrl` is invoked with the authorize URL once the local server is listening,
 * so callers can show the URL to the user as a manual fallback when the browser
 * fails to open (common on WSL2, headless SSH, Docker, etc.). To match the
 * login flow it fires immediately before the browser is opened.
 *
 * `execFile` is injectable so tests can avoid launching a real browser.
 */
export async function awaitBrowserCallback<T>(options: {
  /** Caller-generated; appended to the callback URL and validated on the incoming request. */
  state: string;
  /** Given `http://localhost:PORT/callback?state=…`, return the URL to open. */
  buildAuthUrl: (callback: URL) => Promise<string> | string;
  /**
   * Runs INSIDE the request handler, after state/error/validate checks pass and
   * BEFORE the success page is rendered. Resolve to settle the outer promise
   * with this value (success page shown); throw to render the failure page and
   * reject the outer promise with the thrown error.
   */
  finalize: (params: URLSearchParams) => Promise<T>;
  /** Map an `?error=…` query to a user message (return null to ignore). */
  describeError?: (params: URLSearchParams) => string | null;
  /**
   * Reject an otherwise-valid callback request (renders a 400 page) WITHOUT
   * settling, so the server keeps listening for a subsequent valid callback.
   * Used by login to reject `?token=` and missing-`code` requests. Return a
   * message to reject, or null to accept.
   */
  validate?: (params: URLSearchParams) => string | null;
  /** Optional, invoked with the authorize URL before the browser is opened. */
  onUrl?: (url: string) => void;
  /** Default 5 minutes. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to the real `node:child_process` `execFile`. */
  execFile?: typeof import('node:child_process').execFile;
}): Promise<T> {
  const http = await import('node:http');
  const { state, buildAuthUrl, finalize, describeError, validate, onUrl } = options;
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const execFile = options.execFile ?? (await import('node:child_process')).execFile;

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      server.close();
      reject(error);
    };

    const succeed = (result: T): void => {
      if (settled) {
        return;
      }
      settled = true;
      server.close();
      resolve(result);
    };

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url!, `http://localhost`);
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      if (url.searchParams.get('state') !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(page('Login failed', 'Invalid login callback. Please try again.'));
        return;
      }

      const errorMessage = describeError?.(url.searchParams);
      if (errorMessage) {
        res.writeHead(403, { 'Content-Type': 'text/html' });
        res.end(page('Login failed', errorMessage));
        fail(new Error(errorMessage));
        return;
      }

      // Reject-but-keep-listening: invalid request shapes (e.g. a stray
      // `?token=`, or a redirect that arrived without a code). The server
      // stays open so the genuine callback can still complete.
      const invalidMessage = validate?.(url.searchParams);
      if (invalidMessage) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(page('Login failed', invalidMessage));
        return;
      }

      // Finalize INSIDE the request path so the browser only sees the success
      // page once the underlying exchange/link succeeds. A finalize failure
      // (expired code, API error, 409 conflict, etc.) renders the failure page
      // and rejects. Guard against the timeout racing the in-flight finalize.
      let result: T;
      try {
        result = await finalize(url.searchParams);
      } catch (err) {
        if (settled) {
          return;
        }
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(page('Login failed', 'Could not complete login. Please try again.'));
        fail(err instanceof Error ? err : new Error('auth: Failed to complete login.'));
        return;
      }

      if (settled) {
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(page('Login successful!', 'You can close this tab and return to the terminal.'));
      succeed(result);
    });

    // Close immediately after callback — don't wait for keep-alive timeout
    server.on('connection', (socket) => socket.unref());

    server.listen(0, '127.0.0.1', async () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        fail(new Error('auth: Failed to start local callback server.'));
        return;
      }

      const port = addr.port;
      const callback = new URL(`http://localhost:${port}/callback`);
      callback.searchParams.set('state', state);

      let authUrl: string;
      try {
        authUrl = await buildAuthUrl(callback);
      } catch (err) {
        fail(err instanceof Error ? err : new Error('auth: Failed to build authorize URL.'));
        return;
      }

      onUrl?.(authUrl);
      openBrowser(authUrl, execFile);
    });

    const timeout = setTimeout(() => {
      fail(new Error('auth: Login timed out after 5 minutes. Try again.'));
    }, timeoutMs);
    timeout.unref();
  });
}

/**
 * Start a local HTTP server, open the browser to the platform login page,
 * and wait for the OAuth callback with a short-lived code. The CLI exchanges
 * the code itself so the localhost callback never accepts bearer tokens.
 *
 * `onUrl` is invoked with the login URL once the local server is listening,
 * so callers can show the URL to the user as a manual fallback when the
 * browser fails to open (common on WSL2, headless SSH, Docker, etc.).
 */
export async function runLogin(
  root: string = process.cwd(),
  provider = 'github',
  onUrl?: (url: string) => void,
): Promise<string> {
  return runPlatformLogin(getApiUrl(root), provider, onUrl);
}

export async function runPlatformLogin(
  origin: string,
  provider = 'github',
  onUrl?: (url: string) => void,
): Promise<string> {
  const { execFile } = await import('node:child_process');

  const apiUrl = normalizePlatformApiUrl(origin);
  const state = randomBytes(32).toString('hex');
  const codeVerifier = createCodeVerifier();
  const codeChallenge = createCodeChallenge(codeVerifier);

  // The exchange runs INSIDE the request handler (via finalize), so an exchange
  // failure renders the failure page.
  return awaitBrowserCallback<string>({
    state,
    execFile,
    onUrl,
    buildAuthUrl: (callback) => {
      const loginUrl = new URL('auth/login', apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`);
      loginUrl.searchParams.set('redirect', callback.href);
      loginUrl.searchParams.set('provider', provider);
      loginUrl.searchParams.set('code_challenge', codeChallenge);
      loginUrl.searchParams.set('code_challenge_method', 'S256');
      return loginUrl.href;
    },
    describeError: (p) =>
      p.get('error') === 'signup_restricted'
        ? 'Signup restricted: your email is not on the approved list for this environment.'
        : null,
    // Keep listening but reject these request shapes: a stray `?token=` is never
    // honored, and a callback without a `code` is ignored until the real one arrives.
    validate: (p) => {
      if (p.has('token')) {
        return 'Invalid login callback. Please try again.';
      }
      if (!p.get('code')) {
        return 'No authorization code received. Please try again.';
      }
      return null;
    },
    finalize: (params) => exchangeLoginCode(apiUrl, params.get('code')!, state, codeVerifier),
  });
}
