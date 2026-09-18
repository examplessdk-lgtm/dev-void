/**
 * Per-project outbound caps and the kill switch live in ROUTING KV, where
 * the proxy (`packages/proxy/src/email.ts`) reads them on every send. The
 * keys and defaults below are the same contract written from both ends —
 * nothing at build time catches a drift, so they are spelled once here for
 * the api's writers (admin UI, operator API).
 */
export const emailSuspendKey = (projectId: string) => `email-suspended:${projectId}`;
export const emailMonthlyLimitKey = (projectId: string) => `email-limit:${projectId}`;
export const emailBurstLimitKey = (projectId: string) => `email-burst-limit:${projectId}`;

/** Mirrors `getMonthlyLimit` in `packages/proxy/src/email.ts`. */
export const DEFAULT_EMAIL_MONTHLY_LIMIT = 200;
/** Mirrors `getBurstLimit` in `packages/proxy/src/email.ts`. */
export const DEFAULT_EMAIL_BURST_LIMIT = 10;

/** Highest override either writer accepts; bounds a typo, not a plan. */
export const MAX_EMAIL_LIMIT = 1_000_000;

/**
 * Undefined means "no usable override" — either the key is absent or it
 * holds a value the proxy would itself reject, in which case the proxy is
 * already serving the default and every reader must say so too.
 */
export function parseEmailLimit(raw: string | null | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Strict form of `parseEmailLimit` for operator input: digits only, within the cap. */
export function parseEmailLimitInput(raw: string): number | undefined {
  if (!/^[1-9]\d*$/.test(raw)) {
    return undefined;
  }
  const n = Number(raw);
  return n <= MAX_EMAIL_LIMIT ? n : undefined;
}
