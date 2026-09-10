/**
 * Secret redaction helpers for env-validation output.
 *
 * Values are redacted (replaced with `<redacted>`) whenever they flow into
 * a user-visible string — `EnvValidationError` messages, CLI reports, the
 * dev-server warning block. The key name is never masked (the user needs
 * it to locate the offending entry).
 *
 * Server env values are production secrets by definition, so validator
 * messages redact the raw input unconditionally. The old `.secret()` /
 * `.public()` masking axis was removed because it did not control storage.
 *
 * Users can opt out of the guard for local debugging via
 * `VOID_ENV_UNMASK=1` in the environment; that path prints a one-shot
 * notice on stderr so the loosened output is visibly attributed.
 *
 * This module is a leaf — no imports from non-leaf modules, safe to reach
 * from both the runtime (worker bundle) and the CLI host.
 */

/** Sentinel emitted in place of a redacted value. */
export const REDACTED = '<redacted>';

/** Environment variable that disables redaction when set to `1`. */
export const UNMASK_ENV_VAR = 'VOID_ENV_UNMASK';

/**
 * Regex matching env key names that almost always carry secrets.
 * Case-insensitive; matched as a substring anywhere in the key.
 */
const SECRET_KEY_RE =
  /KEY|TOKEN|SECRET|PASSWORD|PASS(WD)?|CREDENTIAL|PRIVATE|AUTH|BEARER|APIKEY|DSN/i;

/** Common secret value prefixes (Stripe, GitHub, Slack, AWS, …). */
const SECRET_VALUE_PREFIX_RE = /^(sk|pk|ghp|xoxb|AKIA)/i;

/** High-entropy alphanumeric string of ≥24 chars. */
const HIGH_ENTROPY_RE = /^[A-Za-z0-9_\-+/=.:]{24,}$/;

/** `true` when the key name heuristically denotes a secret. */
export function isLikelySecretKey(name: string): boolean {
  return SECRET_KEY_RE.test(name);
}

/**
 * `true` when the value looks like a credential regardless of key name.
 * Err on the side of redacting — a false positive hides one non-secret
 * debugging hint, a false negative pastes a token into a GitHub issue.
 */
export function isLikelySecretValue(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  return SECRET_VALUE_PREFIX_RE.test(value) || HIGH_ENTROPY_RE.test(value);
}

export type MaskOptions = {
  /** When true, the env unmask escape hatch has been honoured. */
  unmask?: boolean;
};

/**
 * Return `value` verbatim when it's safe to display, else `<redacted>`.
 * The `key` parameter is used only for the name heuristic and is never
 * redacted itself.
 */
export function maskValue(key: string, value: unknown, options: MaskOptions = {}): string {
  if (options.unmask) {
    return stringifyForDisplay(value);
  }
  if (isLikelySecretKey(key)) {
    return REDACTED;
  }
  if (isLikelySecretValue(value)) {
    return REDACTED;
  }
  return stringifyForDisplay(value);
}

/**
 * Redact every occurrence of `raw` inside a validator-produced `message`
 * when the key should be masked. Built-in helpers embed the raw value in
 * their error strings (e.g. `Expected a number, got "not-a-number"`); we
 * scrub those after the fact so third-party Standard Schema libraries —
 * which have their own message format — also get reasonable redaction as
 * long as the offending value was a secret-looking literal.
 */
export function redactMessage(
  key: string,
  rawValue: unknown,
  message: string,
  options: MaskOptions = {},
): string {
  if (options.unmask) {
    return message;
  }
  if (typeof rawValue !== 'string' || rawValue.length === 0) {
    return message;
  }
  // Replace every literal occurrence of the raw value with the sentinel.
  // `split/join` avoids constructing a user-controlled regex.
  return message.split(rawValue).join(REDACTED);
}

function stringifyForDisplay(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null) {
    return 'null';
  }
  try {
    return String(value);
  } catch {
    return REDACTED;
  }
}

let unmaskResolved: boolean | null = null;
let unmaskNoticeShown = false;

/**
 * Resolve the effective unmask flag, consulting `process.env` exactly once
 * per process. On the first affirmative read, we print a one-shot notice to
 * stderr so CI logs clearly show the guard is off.
 */
export function isUnmaskActive(): boolean {
  if (unmaskResolved !== null) {
    return unmaskResolved;
  }
  let active = false;
  try {
    // `process` may not exist in some worker bundles; ignore if missing.
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    active = proc?.env?.[UNMASK_ENV_VAR] === '1';
  } catch {
    active = false;
  }
  unmaskResolved = active;
  if (active && !unmaskNoticeShown) {
    unmaskNoticeShown = true;
    try {
      // eslint-disable-next-line no-console -- explicit operator warning.
      console.error(
        `[void/env] ${UNMASK_ENV_VAR}=1 is set — env validation errors will include raw values. Unset it before sharing logs.`,
      );
    } catch {
      // best-effort
    }
  }
  return active;
}

/** Test hook — resets the memoised unmask state. Not part of the public API. */
export function _resetUnmaskCacheForTests(): void {
  unmaskResolved = null;
  unmaskNoticeShown = false;
}
