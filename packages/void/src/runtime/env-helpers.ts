import type { SecretOverride } from '../shared/env-mask.ts';
/**
 * Built-in env schema helpers — Standard Schema-conformant.
 *
 * Returned objects implement {@link https://standardschema.dev}, so they
 * flow through the same validation pipeline as user-supplied schemas
 * (valibot/zod/arktype/etc.) accepted by `defineEnv`.
 *
 * Every helper returns a fluent builder with `.optional()` and
 * `.default(value)` modifiers.
 */
import type { StandardSchemaV1 } from '../standard-schema.ts';

interface ParseResult<T> {
  ok: true;
  value: T;
}
interface ParseError {
  ok: false;
  message: string;
}

type Parser<T> = (raw: string) => ParseResult<T> | ParseError;

interface BuilderState<T> {
  optional: boolean;
  defaultValue: T | undefined;
  secretOverride: SecretOverride;
}

/**
 * Marker property read by the mask helpers. Present only on built-in
 * schema builders; third-party Standard Schema validators fall back to the
 * name/value heuristic (documented in `docs/guide/env-vars.md`).
 */
export const SECRET_OVERRIDE_SYMBOL: unique symbol = Symbol.for('void.env.secretOverride');

/**
 * Pull the explicit `.secret()` / `.public()` flag off a Standard Schema
 * validator, if it was authored through our built-in helpers. Returns
 * `undefined` for third-party validators (valibot, zod, arktype, …) —
 * they are redacted purely via the heuristic.
 */
export function getSecretOverride(
  validator: { [SECRET_OVERRIDE_SYMBOL]?: SecretOverride } | unknown,
): SecretOverride {
  if (!validator || typeof validator !== 'object') {
    return undefined;
  }
  return (validator as { [SECRET_OVERRIDE_SYMBOL]?: SecretOverride })[SECRET_OVERRIDE_SYMBOL];
}

export interface EnvSchema<T> extends StandardSchemaV1<unknown, T> {
  optional(): EnvSchema<T | undefined>;
  default(value: NonNullable<T>): EnvSchema<NonNullable<T>>;
  /**
   * Force redaction of this key's value in every validation/error surface,
   * regardless of the key-name / value-content heuristics.
   */
  secret(): EnvSchema<T>;
  /**
   * Opt this key out of redaction — useful for public config (URLs, app
   * titles) that happens to match the heuristic (`PUBLIC_KEY`, `…_TOKEN_URL`).
   */
  public(): EnvSchema<T>;
}

function build<T>(parse: Parser<T>, state: BuilderState<T>): EnvSchema<T> {
  const schema: EnvSchema<T> = {
    '~standard': {
      version: 1,
      vendor: 'void',
      validate(value) {
        const isMissing = value === undefined || value === null || value === '';
        if (isMissing) {
          if (state.defaultValue !== undefined) {
            return { value: state.defaultValue };
          }
          if (state.optional) {
            return { value: undefined as T };
          }
          return { issues: [{ message: 'Required' }] };
        }
        const raw = typeof value === 'string' ? value : String(value);
        const result = parse(raw);
        if (result.ok) {
          return { value: result.value };
        }
        return { issues: [{ message: result.message }] };
      },
    },
    optional() {
      return build<T | undefined>(parse as Parser<T | undefined>, {
        optional: true,
        defaultValue: state.defaultValue,
        secretOverride: state.secretOverride,
      });
    },
    default(value: NonNullable<T>): EnvSchema<NonNullable<T>> {
      return build<NonNullable<T>>(parse as Parser<NonNullable<T>>, {
        optional: false,
        defaultValue: value,
        secretOverride: state.secretOverride,
      });
    },
    secret() {
      return build<T>(parse, { ...state, secretOverride: 'secret' });
    },
    public() {
      return build<T>(parse, { ...state, secretOverride: 'public' });
    },
  };
  // Non-enumerable so it doesn't pollute `Object.keys` on user schemas.
  Object.defineProperty(schema, SECRET_OVERRIDE_SYMBOL, {
    value: state.secretOverride,
    enumerable: false,
    configurable: true,
  });
  return schema;
}

const empty = <T>(): BuilderState<T> => ({
  optional: false,
  defaultValue: undefined,
  secretOverride: undefined,
});

/** Required string env value. */
export function string(): EnvSchema<string> {
  return build<string>((raw) => ({ ok: true, value: raw }), empty());
}

/** Numeric env value. Parses with `Number(raw)`; rejects NaN. */
export function number(): EnvSchema<number> {
  return build<number>((raw) => {
    const n = Number(raw);
    if (Number.isNaN(n)) {
      return { ok: false, message: `Expected a number, got "${raw}"` };
    }
    return { ok: true, value: n };
  }, empty());
}

/** Boolean env value. Accepts "true"/"false"/"1"/"0" (case-insensitive). */
export function boolean(): EnvSchema<boolean> {
  return build<boolean>((raw) => {
    const lc = raw.toLowerCase();
    if (lc === 'true' || lc === '1') {
      return { ok: true, value: true };
    }
    if (lc === 'false' || lc === '0') {
      return { ok: true, value: false };
    }
    return { ok: false, message: `Expected boolean (true/false/1/0), got "${raw}"` };
  }, empty());
}

/** URL string — validated via `new URL(raw)`. */
export function url(): EnvSchema<string> {
  return build<string>((raw) => {
    try {
      new URL(raw);
      return { ok: true, value: raw };
    } catch {
      return { ok: false, message: `Expected a valid URL, got "${raw}"` };
    }
  }, empty());
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Email string — basic shape validation. */
export function email(): EnvSchema<string> {
  return build<string>((raw) => {
    if (!EMAIL_RE.test(raw)) {
      return { ok: false, message: `Expected a valid email, got "${raw}"` };
    }
    return { ok: true, value: raw };
  }, empty());
}

/** One of a fixed set of literal string values. */
export function oneOf<const Values extends ReadonlyArray<string>>(
  values: Values,
): EnvSchema<Values[number]> {
  return build<Values[number]>((raw) => {
    if ((values as ReadonlyArray<string>).includes(raw)) {
      return { ok: true, value: raw as Values[number] };
    }
    return {
      ok: false,
      message: `Expected one of ${values.join(', ')}, got "${raw}"`,
    };
  }, empty());
}

/** JSON-parsed env value. Specify `T` to type the parsed result. */
export function json<T = unknown>(): EnvSchema<T> {
  return build<T>((raw) => {
    try {
      return { ok: true, value: JSON.parse(raw) as T };
    } catch (e) {
      return { ok: false, message: `Invalid JSON: ${(e as Error).message}` };
    }
  }, empty());
}
