import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { Entry } from '@napi-rs/keyring';
import { join } from 'pathe';
import { cfAccessHeaders } from '../shared/cf-access.ts';
import { ensureCloudflaredToken } from './cf-access.ts';
import { pc } from './output.ts';
import { isVoidInternalStaging } from './project.ts';

const CONFIG_DIR = join(homedir(), '.void');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

const KEYRING_SERVICE = 'dev.void.cli';

// ---------------------------------------------------------------------------
// Keyring helpers — try/catch around `new Entry` for environments where the
// native addon fails at runtime (CI, Docker, SSH, etc.)
// ---------------------------------------------------------------------------

function keyringGet(account: string): string | null {
  try {
    return new Entry(KEYRING_SERVICE, account).getPassword();
  } catch {
    return null;
  }
}

function keyringSet(account: string, password: string): boolean {
  try {
    new Entry(KEYRING_SERVICE, account).setPassword(password);
    return true;
  } catch {
    return false;
  }
}

function keyringDelete(account: string): boolean {
  try {
    new Entry(KEYRING_SERVICE, account).deletePassword();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Config file — non-sensitive fields only (api).
// Token fields are kept in the type for migration reads.
// ---------------------------------------------------------------------------

type Config = {
  token?: string;
  stagingToken?: string;
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

export function isStagingMode(root: string = process.cwd()): boolean {
  return isVoidInternalStaging(root);
}

export function getSiteDomain(root: string = process.cwd()): string {
  return isStagingMode(root) ? 'staging.void.app' : 'void.app';
}

/**
 * Read the deploy token.
 * Priority: VOID_TOKEN env var > system keychain > ~/.void/config.json (auto-migrated)
 */
export function getToken(root: string = process.cwd()): string | null {
  const envToken = process.env.VOID_TOKEN;
  if (envToken) {
    return envToken;
  }

  const account = isStagingMode(root) ? 'stagingToken' : 'token';

  // Try keyring first
  const keyringToken = keyringGet(account);
  if (keyringToken) {
    return keyringToken;
  }

  // File fallback — auto-migrate to keyring if available
  const config = readConfig();
  const fileToken = config[account];
  if (fileToken) {
    if (keyringSet(account, fileToken)) {
      // Successfully migrated — best-effort cleanup of the config-file copy.
      // Failures here (read-only FS, permission denied, full disk) must not
      // crash callers. Token stays in the file; next invocation will retry.
      delete config[account];
      try {
        writeConfig(config);
      } catch {
        // Ignore — migration is best-effort.
      }
    }
    return fileToken;
  }

  return null;
}

export function getTokenSource(): 'ci' | 'manual' {
  return process.env.VOID_TOKEN ? 'ci' : 'manual';
}

export function saveToken(token: string, root: string = process.cwd()): void {
  const account = isStagingMode(root) ? 'stagingToken' : 'token';
  if (keyringSet(account, token)) {
    return;
  }

  // Keyring unavailable — fall back to file
  console.warn(pc.yellow('System keychain unavailable, storing token in ~/.void/config.json'));
  const config = readConfig();
  config[account] = token;
  writeConfig(config);
}

export function removeToken(root: string = process.cwd()): boolean {
  const account = isStagingMode(root) ? 'stagingToken' : 'token';
  let removed = false;

  // Remove from keyring
  if (keyringDelete(account)) {
    removed = true;
  }

  // Also clean up config file if token exists there
  try {
    const config = readConfig();
    if (config[account]) {
      delete config[account];
      writeConfig(config);
      removed = true;
    }
  } catch {
    // ignore
  }

  return removed;
}

const DEFAULT_API_URL = 'https://api.void.cloud';
const STAGING_API_URL = 'https://api.staging.void.cloud';

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function createCodeVerifier(): string {
  return base64Url(randomBytes(32));
}

function createCodeChallenge(verifier: string): string {
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
    headers: { 'Content-Type': 'application/json', ...cfAccessHeaders(process.env) },
    body: JSON.stringify({
      code,
      state,
      code_verifier: codeVerifier,
    }),
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

/**
 * Read the API URL from environment or config file.
 * Priority: VOID_API_URL env var > ~/.void/config.json > default
 */
export function getApiUrl(root: string = process.cwd()): string {
  return (
    process.env.VOID_API_URL ??
    readConfig().api ??
    (isStagingMode(root) ? STAGING_API_URL : DEFAULT_API_URL)
  );
}

function page(title: string, message: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} - Void</title>
<style>:root{color-scheme:light dark}*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fafafa;color:#111}.card{text-align:center;padding:3rem}h1{font-size:1.5rem;font-weight:600;margin-bottom:.75rem}p{color:#666;font-size:1rem}@media (prefers-color-scheme:dark){body{background:#0a0a0a;color:#fafafa}p{color:#a3a3a3}}</style>
</head><body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

export function openBrowser(url: string, exec: typeof import('node:child_process').exec): void {
  if (process.platform === 'win32') {
    // `start` treats the first quoted arg as window title, pass empty title
    exec(`start "" "${url}"`);
    return;
  }
  if (process.platform === 'darwin') {
    exec(`open "${url}"`);
    return;
  }
  // Linux — including WSL2 where `xdg-open` typically has no usable handler.
  // Try `wslview` (wslu), then `cmd.exe /c start`, then fall back to `xdg-open`.
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    exec(`wslview "${url}" 2>/dev/null || cmd.exe /c start "" "${url}" 2>/dev/null`);
    return;
  }
  exec(`xdg-open "${url}"`);
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
  const http = await import('node:http');
  const { exec } = await import('node:child_process');

  const apiUrl = getApiUrl(root);
  const state = randomBytes(32).toString('hex');
  const codeVerifier = createCodeVerifier();
  const codeChallenge = createCodeChallenge(codeVerifier);

  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      server.close();
      reject(error);
    };

    const succeed = (token: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      server.close();
      resolve(token);
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

      const error = url.searchParams.get('error');
      if (error === 'signup_restricted') {
        res.writeHead(403, { 'Content-Type': 'text/html' });
        res.end(
          page('Signup restricted', 'Your email is not on the approved list for this environment.'),
        );
        fail(
          new Error(
            'Signup restricted: your email is not on the approved list for this environment.',
          ),
        );
        return;
      }

      if (url.searchParams.has('token')) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(page('Login failed', 'Invalid login callback. Please try again.'));
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(page('Login failed', 'No authorization code received. Please try again.'));
        return;
      }

      let token: string;
      try {
        token = await exchangeLoginCode(apiUrl, code, state, codeVerifier);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(page('Login failed', 'Could not complete login. Please try again.'));
        fail(err instanceof Error ? err : new Error('auth: Failed to complete login.'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(page('Login successful!', 'You can close this tab and return to the terminal.'));
      succeed(token);
    });

    // Close immediately after callback — don't wait for keep-alive timeout
    server.on('connection', (socket) => socket.unref());

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('auth: Failed to start local callback server.'));
        return;
      }

      const port = addr.port;
      const redirect = new URL(`http://localhost:${port}/callback`);
      redirect.searchParams.set('state', state);

      const loginUrl = new URL('auth/login', apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`);
      loginUrl.searchParams.set('redirect', redirect.href);
      loginUrl.searchParams.set('provider', provider);
      loginUrl.searchParams.set('code_challenge', codeChallenge);
      loginUrl.searchParams.set('code_challenge_method', 'S256');

      onUrl?.(loginUrl.href);
      openBrowser(loginUrl.href, exec);
    });

    // 5-minute timeout
    const timeout = setTimeout(
      () => {
        fail(new Error('auth: Login timed out after 5 minutes. Try again.'));
      },
      5 * 60 * 1000,
    );
    timeout.unref();
  });
}
