/** Default monthly outbound recipient-attempt cap. */
export const DEFAULT_EMAIL_MONTHLY_LIMIT = 200;
/** Default per-minute outbound recipient-attempt cap. */
export const DEFAULT_EMAIL_BURST_LIMIT = 10;

/** Highest override either writer accepts; bounds a typo, not a plan. */
export const MAX_EMAIL_LIMIT = 1_000_000;

/** Parse a positive integer limit within the supported cap. */
export function parseEmailLimitInput(raw: string): number | undefined {
  if (!/^[1-9]\d*$/.test(raw)) {
    return undefined;
  }
  const n = Number(raw);
  return n <= MAX_EMAIL_LIMIT ? n : undefined;
}
