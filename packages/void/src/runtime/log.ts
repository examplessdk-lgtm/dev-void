/**
 * Structured logger that emits each entry as a single stringified-JSON line
 * to `console.error/warn/info`. The shape `{ msg, ...fields }` is a stable
 * contract: Cloudflare Tail captures each call as one `logs[]` entry with
 * the right `level`, and platform-side log filtering can match on `msg` or
 * any custom field.
 *
 * @example
 * ```ts
 * import { logger } from "void/log";
 *
 * logger.error("websocket failed", { jobId, attempt: 3 });
 * logger.info("user signed in", { userId });
 * ```
 */

type Fields = Record<string, unknown>;

function format(message: string, fields?: Fields): string {
  // `msg` first key for greppability; remaining fields after. The `message`
  // arg always wins over a user-provided `fields.msg` (safer — never silently
  // drops the explicit primary message).
  //
  // Use `Object.create(null)` so the payload has no prototype chain — this
  // makes assigning `payload.__proto__ = ...` a plain own-property write
  // instead of triggering the `Object.prototype.__proto__` setter (which
  // would mutate the payload's prototype and let an inherited `toJSON`
  // hijack `JSON.stringify`).
  //
  // Use `Object.entries` (own enumerable keys only) instead of `for...in` to
  // avoid copying inherited properties. Skip `toJSON` so a user-provided
  // method cannot hijack `JSON.stringify(payload)` and emit an arbitrary
  // shape that bypasses the `msg` contract. Skip `__proto__` and
  // `constructor` for defense in depth (the null-prototype payload already
  // neutralizes the `__proto__` setter, but skipping the keys keeps the
  // intent explicit). Skip function values for the same reason —
  // `JSON.stringify` would silently drop them, but excluding them explicitly
  // keeps the output deterministic.
  //
  // The whole field-normalization loop runs inside the try/catch because
  // `Object.entries(fields)` itself may invoke enumerable getters or proxy
  // traps that throw. A logging call must never propagate exceptions from
  // user-provided fields.
  try {
    const payload: Record<string, unknown> = Object.create(null);
    payload.msg = message;
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        if (key === 'msg' || key === 'toJSON' || key === '__proto__' || key === 'constructor') {
          continue;
        }
        if (typeof value === 'function') {
          continue;
        }
        payload[key] = value;
      }
    }
    return JSON.stringify(payload);
  } catch {
    // Non-stringifiable values (e.g. circular refs) or throwing accessors
    // /proxy traps — fall back to a safe shape so a logging call never
    // throws.
    return JSON.stringify({ msg: message, error: 'log: fields not serializable' });
  }
}

export const logger = {
  error(message: string, fields?: Fields): void {
    console.error(format(message, fields));
  },
  warn(message: string, fields?: Fields): void {
    console.warn(format(message, fields));
  },
  info(message: string, fields?: Fields): void {
    console.info(format(message, fields));
  },
};
