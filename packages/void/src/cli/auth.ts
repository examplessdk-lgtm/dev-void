import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { Entry } from '@napi-rs/keyring';
import { join } from 'pathe';
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
// Token fields are kept in the interface for migration reads.
// ---------------------------------------------------------------------------

interface Config {
  token?: string;
  stagingToken?: string;
  api?: string;
}

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

function openBrowser(url: string, exec: typeof import('node:child_process').exec): void {
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
 * and wait for the OAuth callback with a JWT token.
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

  return new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost`);
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const error = url.searchParams.get('error');
      if (error === 'signup_restricted') {
        res.writeHead(403, { 'Content-Type': 'text/html' });
        res.end(
          page('Signup restricted', 'Your email is not on the approved list for this environment.'),
        );
        server.close();
        reject(
          new Error(
            'Signup restricted: your email is not on the approved list for this environment.',
          ),
        );
        return;
      }

      const token = url.searchParams.get('token');
      if (!token) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(page('Login failed', 'No token received. Please try again.'));
        server.close();
        reject(new Error('auth: No token received from callback. Try logging in again.'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(page('Login successful!', 'You can close this tab and return to the terminal.'));
      server.close();
      resolve(token);
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
      const redirect = `http://localhost:${port}/callback`;
      const loginUrl = `${apiUrl}/auth/login?redirect=${encodeURIComponent(redirect)}&provider=${provider}`;

      onUrl?.(loginUrl);
      openBrowser(loginUrl, exec);
    });

    // 5-minute timeout
    const timeout = setTimeout(
      () => {
        server.close();
        reject(new Error('auth: Login timed out after 5 minutes. Try again.'));
      },
      5 * 60 * 1000,
    );
    timeout.unref();
  });
}
