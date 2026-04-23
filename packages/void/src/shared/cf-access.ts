/**
 * Cloudflare Access service-token headers for programmatic callers of hostnames
 * protected by CF Access (e.g. the staging environment).
 *
 * Returns an empty object when either credential is missing so the same call
 * sites work unchanged against unprotected hostnames (prod).
 */
export function cfAccessHeaders(id: unknown, secret: unknown): Record<string, string> {
  if (
    typeof id !== 'string' ||
    typeof secret !== 'string' ||
    id.length === 0 ||
    secret.length === 0
  ) {
    return {};
  }
  return {
    'CF-Access-Client-Id': id,
    'CF-Access-Client-Secret': secret,
  };
}
