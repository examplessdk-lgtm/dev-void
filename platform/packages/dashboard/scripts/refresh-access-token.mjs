import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEV_VARS = join(process.cwd(), '.dev.vars');

function parseDotenv(contents) {
  const out = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const index = trimmed.indexOf('=');
    if (index === -1) {
      continue;
    }
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function isStagingApi(url) {
  try {
    const { hostname } = new URL(url);
    return hostname.endsWith('.staging.void.cloud') || hostname.endsWith('.staging.void.app');
  } catch {
    return false;
  }
}

function tokenExpiry(token) {
  const [, payload] = token.split('.');
  if (!payload) {
    return null;
  }

  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof exp === 'number' ? exp : null;
  } catch {
    return null;
  }
}

function isUsableToken(token) {
  const exp = tokenExpiry(token);
  return exp !== null && exp > Math.floor(Date.now() / 1000) + 60;
}

function runCloudflared(args, options = {}) {
  const result = spawnSync('cloudflared', args, {
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs ?? 5_000,
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  const out = result.stdout?.trim();
  return out ? out : null;
}

function setDevVar(contents, key, value) {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const line = `${key}="${escaped}"`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(contents)) {
    return contents.replace(pattern, line);
  }
  return `${contents.replace(/\s*$/, '')}\n${line}\n`;
}

const devVars = existsSync(DEV_VARS) ? parseDotenv(readFileSync(DEV_VARS, 'utf8')) : {};
const apiUrl = process.env.API_URL ?? devVars.API_URL;

if (!apiUrl || !isStagingApi(apiUrl)) {
  process.exit(0);
}

if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
  process.exit(0);
}

if (process.env.CF_ACCESS_TOKEN && isUsableToken(process.env.CF_ACCESS_TOKEN)) {
  process.exit(0);
}

if (devVars.CF_ACCESS_TOKEN && isUsableToken(devVars.CF_ACCESS_TOKEN)) {
  process.exit(0);
}

const app = new URL(apiUrl).origin;
let token = runCloudflared(['access', 'token', `-app=${app}`]);

if (!token && process.stdin.isTTY && process.stdout.isTTY) {
  console.log(`[dashboard] Cloudflare Access token for ${app} is missing or expired.`);
  runCloudflared(['access', 'login', app], { inherit: true, timeoutMs: 120_000 });
  token = runCloudflared(['access', 'token', `-app=${app}`]);
}

if (!token || !isUsableToken(token)) {
  console.warn(
    `[dashboard] Could not refresh Cloudflare Access token for ${app}. Run: cloudflared access login ${app}`,
  );
  process.exit(1);
}

const current = existsSync(DEV_VARS) ? readFileSync(DEV_VARS, 'utf8') : '';
writeFileSync(DEV_VARS, setDevVar(current, 'CF_ACCESS_TOKEN', token));
console.log(`[dashboard] Refreshed Cloudflare Access token for ${app}.`);
