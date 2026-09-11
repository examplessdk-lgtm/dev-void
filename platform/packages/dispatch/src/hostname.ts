import { SITE_DOMAIN } from './constants.ts';

/**
 * Extract the project slug from a hostname.
 * Returns null if the hostname doesn't match the expected pattern.
 *
 * Examples:
 *   "my-app.void.app" → "my-app"
 *   "void.app" → null
 *   "foo.bar.void.app" → null (no subdomains)
 *   "example.com" → null
 */
export function extractSlug(hostname: string, baseHostname: string = SITE_DOMAIN): string | null {
  const suffix = `.${baseHostname}`;
  if (!hostname.endsWith(suffix)) {
    return null;
  }

  const slug = hostname.slice(0, -suffix.length);

  // Must be non-empty and contain no dots (no nested subdomains)
  if (!slug || slug.includes('.')) {
    return null;
  }

  // Validate slug format: lowercase alphanumeric + dashes, no leading/trailing dash
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    return null;
  }

  return slug;
}
