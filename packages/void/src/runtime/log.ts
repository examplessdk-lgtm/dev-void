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
  // `message` always wins over `fields.msg`. The loop sits inside the try because
  // getters and proxy traps on `fields` may throw; logging must never throw.
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
