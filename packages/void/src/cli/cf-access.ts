import { spawnSync } from 'node:child_process';
import { isVoidAccessGatedUrl } from '../shared/cf-access.ts';

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
