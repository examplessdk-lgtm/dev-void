/** Longest hostname RFC 1035 allows; checked on the raw input before any normalization. */
export const MAX_DOMAIN_LENGTH = 253;

export function normalizeEmailDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * DNS hostname shape: two or more labels, each 1–63 chars, alphanumeric +
 * interior hyphens. Real validation is the engine's zone lookup — this
 * keeps junk out of the encrypt and CF calls.
 */
export function isValidEmailDomain(domain: string): boolean {
  return /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(domain);
}
