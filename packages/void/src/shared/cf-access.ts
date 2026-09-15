/**
 * Resolve Cloudflare Access headers from an env-like object.
 *
 * Priority:
 *   1. Service token pair (`CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET`) — CI path
 *   2. User JWT (`CF_ACCESS_TOKEN`) — dev path, typically populated via `cloudflared access token`
 *   3. No headers — prod, or unprotected hostnames
 */
export function isVoidAccessGatedUrl(targetUrl: string): boolean {
  try {
    const url = new URL(targetUrl);
    return (
      url.protocol === 'https:' &&
      (url.hostname.endsWith('.staging.void.cloud') || url.hostname.endsWith('.staging.void.app'))
    );
  } catch {
    return false;
  }
}

function accessHeaders(env: Record<string, unknown>): Record<string, string> {
  const id = env.CF_ACCESS_CLIENT_ID;
  const secret = env.CF_ACCESS_CLIENT_SECRET;
  if (typeof id === 'string' && typeof secret === 'string' && id.length > 0 && secret.length > 0) {
    return {
      'CF-Access-Client-Id': id,
      'CF-Access-Client-Secret': secret,
    };
  }
  const token = env.CF_ACCESS_TOKEN;
  if (typeof token === 'string' && token.length > 0) {
    return { 'cf-access-token': token };
  }
  return {};
}

/** Attach shared Void Access credentials only to known hosted staging origins. */
export function cfAccessHeaders(
  env: Record<string, unknown>,
  targetUrl: string,
): Record<string, string> {
  return isVoidAccessGatedUrl(targetUrl) ? accessHeaders(env) : {};
}

/**
 * Capture credentials for a Cloudflare Worker readiness request whose target
 * is resolved and constrained by the direct-deploy adapter rather than a
 * user-connected Void platform URL.
 */
export function trustedCloudflareWorkerAccessHeaders(
  env: Record<string, unknown>,
): Record<string, string> {
  return accessHeaders(env);
}
