import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { boolean, email, json, number, oneOf, string, url } from '../../src/runtime/env-helpers.ts';
import {
  defineEnv,
  env,
  EnvValidationError,
  validateAllEnv,
  _getRegisteredSchema,
  _getSchemaDefaults,
  _hasRegisteredSchema,
  _validateEnvOnce,
} from '../../src/runtime/env-public.ts';
import { getRuntimeBinding, requireRuntimeBinding, withRuntimeEnv } from '../../src/runtime/env.ts';

// Reset schema between tests so order doesn't leak state.
function resetSchema() {
  defineEnv({});
}

describe('env helpers (Standard Schema)', () => {
  it('string accepts any value, rejects missing', () => {
    expect(string()['~standard'].validate('hello')).toEqual({ value: 'hello' });
    const result = string()['~standard'].validate(undefined);
    expect('issues' in result && result.issues).toBeTruthy();
  });

  it('number parses and rejects NaN', () => {
    expect(number()['~standard'].validate('42')).toEqual({ value: 42 });
    const bad = number()['~standard'].validate('not-a-number');
    expect('issues' in bad && bad.issues).toBeTruthy();
  });

  it('boolean accepts true/false/1/0 case-insensitively', () => {
    expect(boolean()['~standard'].validate('true')).toEqual({ value: true });
    expect(boolean()['~standard'].validate('FALSE')).toEqual({ value: false });
    expect(boolean()['~standard'].validate('1')).toEqual({ value: true });
    expect(boolean()['~standard'].validate('0')).toEqual({ value: false });
    const bad = boolean()['~standard'].validate('maybe');
    expect('issues' in bad && bad.issues).toBeTruthy();
  });

  it('url validates with new URL()', () => {
    expect(url()['~standard'].validate('https://example.com')).toEqual({
      value: 'https://example.com',
    });
    const bad = url()['~standard'].validate('not a url');
    expect('issues' in bad && bad.issues).toBeTruthy();
  });

  it('email validates basic shape', () => {
    expect(email()['~standard'].validate('a@b.com')).toEqual({ value: 'a@b.com' });
    const bad = email()['~standard'].validate('nope');
    expect('issues' in bad && bad.issues).toBeTruthy();
  });

  it('oneOf restricts to enum members', () => {
    const schema = oneOf(['development', 'production'] as const);
    expect(schema['~standard'].validate('production')).toEqual({ value: 'production' });
    const bad = schema['~standard'].validate('staging');
    expect('issues' in bad && bad.issues).toBeTruthy();
  });

  it('json parses JSON strings', () => {
    const schema = json<{ a: number }>();
    expect(schema['~standard'].validate('{"a":1}')).toEqual({ value: { a: 1 } });
    const bad = schema['~standard'].validate('{not json}');
    expect('issues' in bad && bad.issues).toBeTruthy();
  });

  it('.optional() makes missing valid (returns undefined)', () => {
    const schema = string().optional();
    expect(schema['~standard'].validate(undefined)).toEqual({ value: undefined });
    expect(schema['~standard'].validate('')).toEqual({ value: undefined });
    expect(schema['~standard'].validate('value')).toEqual({ value: 'value' });
  });

  it('.default() supplies a fallback for missing values', () => {
    const schema = number().default(42);
    expect(schema['~standard'].validate(undefined)).toEqual({ value: 42 });
    expect(schema['~standard'].validate('')).toEqual({ value: 42 });
    expect(schema['~standard'].validate('7')).toEqual({ value: 7 });
  });
});

describe('defineEnv + env proxy', () => {
  beforeEach(() => {
    resetSchema();
  });

  it('registers schema and exposes typed values via env proxy', () => {
    defineEnv({
      STRIPE_KEY: string(),
      PORT: number().default(3000),
    });
    withRuntimeEnv({ STRIPE_KEY: 'sk_test', PORT: '4000' }, () => {
      expect(env.STRIPE_KEY).toBe('sk_test');
      expect(env.PORT).toBe(4000);
    });
  });

  it('applies defaults when env value is missing', () => {
    defineEnv({ PORT: number().default(3000) });
    withRuntimeEnv({}, () => {
      expect(env.PORT).toBe(3000);
    });
  });

  it('throws EnvValidationError on access to invalid value', () => {
    defineEnv({ PORT: number() });
    withRuntimeEnv({ PORT: 'not-a-number' }, () => {
      expect(() => env.PORT).toThrow(EnvValidationError);
    });
  });

  it('throws EnvValidationError on access to missing required key', () => {
    defineEnv({ STRIPE_KEY: string() });
    withRuntimeEnv({}, () => {
      expect(() => env.STRIPE_KEY).toThrow(EnvValidationError);
    });
  });

  it('passes through bindings/unknown keys without validation', () => {
    defineEnv({ STRIPE_KEY: string() });
    const fakeDb = { binding: true };
    withRuntimeEnv({ STRIPE_KEY: 'sk', DB: fakeDb }, () => {
      expect(env.DB).toBe(fakeDb);
    });
  });

  it('caches validated values per env identity (no re-validation)', () => {
    let calls = 0;
    const inner = string();
    const counted = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: (v: unknown) => {
          calls++;
          return inner['~standard'].validate(v);
        },
      },
    };
    defineEnv({ X: counted });
    const e = { X: 'hello' };
    withRuntimeEnv(e, () => {
      void env.X;
      void env.X;
      void env.X;
    });
    expect(calls).toBe(1);
  });

  it('exposes registered schema via _getRegisteredSchema', () => {
    defineEnv({ FOO: string() });
    expect(Object.keys(_getRegisteredSchema() ?? {})).toEqual(['FOO']);
  });

  it('_hasRegisteredSchema distinguishes defineEnv({}) from never-called', () => {
    // resetSchema() already called defineEnv({}) in beforeEach.
    expect(_hasRegisteredSchema()).toBe(true);
    // Registered schema is still an empty object — not null — but the
    // presence flag tells us defineEnv was explicitly invoked.
    expect(_getRegisteredSchema()).toEqual({});
    // Calling with a real schema also keeps the flag on.
    defineEnv({ FOO: string() });
    expect(_hasRegisteredSchema()).toBe(true);
  });
});

describe('redaction roundtrip (heuristic + content)', () => {
  beforeEach(() => {
    resetSchema();
  });

  it('omits placeholder values when a required STRIPE_KEY is missing', async () => {
    defineEnv({ STRIPE_KEY: string() });
    const report = await validateAllEnv({});
    const formatted = report.missing.join(' ');
    expect(formatted).toContain('STRIPE_KEY');
    // No secret-looking fragment leaked into the report.
    expect(formatted).not.toMatch(/sk_|ghp_/);
  });

  it('redacts a secret-looking value even when the key name is neutral (wrong-file typo)', async () => {
    // Scenario: user pastes `PORT=sk_live_abc123` into the wrong line.
    // `number()` rejects it, and the error message must NOT echo the token.
    defineEnv({ PORT: number() });
    const bad = await validateAllEnv({ PORT: 'sk_live_abc123' });
    expect(bad.valid).toBe(false);
    const msg = bad.invalid[0]!.messages.join(' ');
    expect(msg).not.toContain('sk_live_abc123');
    expect(msg).toContain('<redacted>');
  });

  it('redacts invalid values when the KEY name matches the heuristic', async () => {
    defineEnv({ STRIPE_KEY: url() });
    const bad = await validateAllEnv({ STRIPE_KEY: 'not a url' });
    expect(bad.valid).toBe(false);
    // Key-name heuristic alone forces redaction even though the value
    // itself ("not a url") is not high-entropy.
    const msg = bad.invalid[0]!.messages.join(' ');
    expect(msg).not.toContain('not a url');
    expect(msg).toContain('<redacted>');
  });

  it('runtime proxy throws EnvValidationError with redacted message', () => {
    defineEnv({ STRIPE_KEY: url() });
    withRuntimeEnv({ STRIPE_KEY: 'sk_live_abc_not_a_url' }, () => {
      try {
        void env.STRIPE_KEY;
        throw new Error('expected throw');
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).not.toContain('sk_live_abc_not_a_url');
        expect(msg).toContain('STRIPE_KEY'); // key name survives
        expect(msg).toContain('<redacted>');
      }
    });
  });
});

describe('validateAllEnv (used by dev plugin and CLI)', () => {
  beforeEach(() => {
    resetSchema();
  });

  it('reports valid when all keys satisfied', async () => {
    defineEnv({ STRIPE_KEY: string(), PORT: number().default(3000) });
    const report = await validateAllEnv({ STRIPE_KEY: 'sk' });
    expect(report.valid).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.invalid).toEqual([]);
  });

  it('separates missing vs invalid', async () => {
    defineEnv({
      STRIPE_KEY: string(),
      PORT: number(),
      MODE: oneOf(['a', 'b'] as const),
    });
    const report = await validateAllEnv({ PORT: 'not-num', MODE: 'c' });
    expect(report.valid).toBe(false);
    expect(report.missing).toEqual(['STRIPE_KEY']);
    expect(report.invalid.map((i) => i.key).sort()).toEqual(['MODE', 'PORT']);
  });

  it('returns valid=true when no schema registered', async () => {
    // After resetSchema(), the schema is empty {} — still counts as registered.
    const report = await validateAllEnv({});
    expect(report.valid).toBe(true);
  });

  it('awaits async Standard Schema validators', async () => {
    const asyncValidator = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: async (v: unknown) => {
          await Promise.resolve();
          if (typeof v === 'string' && v.startsWith('ok-')) {
            return { value: v.slice(3) };
          }
          return { issues: [{ message: 'must start with ok-' }] };
        },
      },
    };
    defineEnv({ TOKEN: asyncValidator });
    const good = await validateAllEnv({ TOKEN: 'ok-value' });
    expect(good.valid).toBe(true);
    expect(good.values.get('TOKEN')).toBe('value');

    // Reset the boot state before re-registering to avoid stale caching.
    defineEnv({ TOKEN: asyncValidator });
    const bad = await validateAllEnv({ TOKEN: 'nope' });
    expect(bad.valid).toBe(false);
    expect(bad.invalid.map((i) => i.key)).toEqual(['TOKEN']);
  });
});

describe('_validateEnvOnce (boot-time worker check)', () => {
  beforeEach(() => {
    resetSchema();
  });

  it('passes when env satisfies the schema', async () => {
    defineEnv({ STRIPE_KEY: string() });
    await expect(_validateEnvOnce({ STRIPE_KEY: 'sk_test' })).resolves.toBeUndefined();
  });

  it('throws EnvValidationError listing all missing/invalid keys', async () => {
    defineEnv({ STRIPE_KEY: string(), PORT: number() });
    await expect(_validateEnvOnce({ PORT: 'oops' })).rejects.toBeInstanceOf(EnvValidationError);
    try {
      await _validateEnvOnce({ PORT: 'oops' });
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('STRIPE_KEY is required');
      expect(msg).toContain('PORT');
    }
  });

  it('caches success — schema is only run once per isolate', async () => {
    let calls = 0;
    const inner = string();
    const counted = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: (v: unknown) => {
          calls++;
          return inner['~standard'].validate(v);
        },
      },
    };
    defineEnv({ X: counted });
    await _validateEnvOnce({ X: 'hello' });
    await _validateEnvOnce({ X: 'hello' });
    await _validateEnvOnce({ X: 'hello' });
    expect(calls).toBe(1);
  });

  it('caches failure so repeat calls re-throw the same error', async () => {
    defineEnv({ STRIPE_KEY: string() });
    let firstError: unknown;
    let secondError: unknown;
    try {
      await _validateEnvOnce({});
    } catch (e) {
      firstError = e;
    }
    try {
      await _validateEnvOnce({});
    } catch (e) {
      secondError = e;
    }
    expect(firstError).toBe(secondError);
  });

  it('is a no-op when no schema is registered', async () => {
    // resetSchema() registers an empty schema, so re-define with truly empty
    // input to verify the no-validate path still passes.
    defineEnv({});
    await expect(_validateEnvOnce(undefined)).resolves.toBeUndefined();
  });

  it('is reset by a new defineEnv call (HMR semantics)', async () => {
    defineEnv({ A: string() });
    await expect(_validateEnvOnce({})).rejects.toBeInstanceOf(EnvValidationError);
    // Re-import / HMR: schema swaps, boot state resets, new env satisfies new schema
    defineEnv({ B: string() });
    await expect(_validateEnvOnce({ B: 'value' })).resolves.toBeUndefined();
  });

  it('awaits async validators and caches resolved values for sync proxy reads', async () => {
    const asyncUpper = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: async (v: unknown) => {
          await Promise.resolve();
          return typeof v === 'string'
            ? { value: v.toUpperCase() }
            : { issues: [{ message: 'must be a string' }] };
        },
      },
    };
    defineEnv({ TOKEN: asyncUpper });
    const rawEnv = { TOKEN: 'sk_test' };
    // Pre-validate seeds the cache so subsequent sync reads are free.
    await withRuntimeEnv(rawEnv, async () => {
      await _validateEnvOnce(rawEnv);
      expect(env.TOKEN).toBe('SK_TEST');
    });
  });

  it('rethrows from async validator failure', async () => {
    const alwaysFail = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: async () => {
          await Promise.resolve();
          return { issues: [{ message: 'nope' }] };
        },
      },
    };
    defineEnv({ TOKEN: alwaysFail });
    await expect(_validateEnvOnce({ TOKEN: 'anything' })).rejects.toBeInstanceOf(
      EnvValidationError,
    );
  });
});

// FIX C + FIX D: internal framework bindings (e.g. ISR_CACHE) must never be
// exposed through void/env WHILE ISR IS ACTIVE — not even when a user's
// defineEnv schema declares one and boot validation resolved and seeded its RAW
// value into the sync cache. When ISR is inactive, a schema-declared ISR_CACHE
// is an ordinary user binding and IS exposed.
describe('_validateEnvOnce — internal bindings stay hidden from void/env', () => {
  beforeEach(() => {
    resetSchema();
  });

  // A passthrough validator so the RAW binding value (a KV-like object) passes
  // boot validation and would otherwise be seeded into the sync cache — this is
  // exactly the leak path FIX C closes (while ISR is active).
  const passthrough = {
    '~standard': {
      version: 1 as const,
      vendor: 'test',
      validate: (v: unknown) => ({ value: v }),
    },
  };

  it('never exposes a schema-declared ISR_CACHE while ISR is active, even after boot validation seeds its raw value', async () => {
    defineEnv({ ISR_CACHE: passthrough, API_KEY: string() });

    const fakeIsrKv = { __brand: 'isr-kv' };
    // `__VOID_ISR_DEPLOYMENT_ID` present ⇒ ISR active ⇒ ISR_CACHE is internal.
    const rawEnv = { ISR_CACHE: fakeIsrKv, API_KEY: 'sk_live', __VOID_ISR_DEPLOYMENT_ID: 'dep_1' };

    await withRuntimeEnv(rawEnv, async () => {
      // Boot validation runs FIRST — as it does at worker boot, before any
      // request reads env.X. It succeeds (raw ISR_CACHE passes the passthrough
      // validator) and, without FIX C, seeds the raw KV binding into the sync
      // cache. Reading env.ISR_CACHE only AFTER this is what exposes the leak: a
      // pre-validation read would mask it by caching `undefined` (the filtered
      // value) so the `if (!cache.has(key))` seed guard would skip re-seeding.
      await _validateEnvOnce(rawEnv);

      // Hidden after boot validation — the seeded raw KV binding must not
      // leak through env.ISR_CACHE / `in` / enumeration.
      expect((env as Record<string, unknown>).ISR_CACHE).toBeUndefined();
      expect('ISR_CACHE' in env).toBe(false);
      expect(Object.keys(env)).not.toContain('ISR_CACHE');

      // Lower-level binding accessors keep hiding it too.
      expect(getRuntimeBinding('ISR_CACHE')).toBeUndefined();
      expect(() => requireRuntimeBinding('ISR_CACHE')).toThrow(
        "env: Missing Cloudflare binding 'ISR_CACHE'.",
      );

      // A normal declared key remains readable (the fix does not over-filter).
      expect(env.API_KEY).toBe('sk_live');
    });
  });

  it('exposes a schema-declared ISR_CACHE when ISR is inactive (no __VOID_ISR_DEPLOYMENT_ID)', async () => {
    defineEnv({ ISR_CACHE: passthrough, API_KEY: string() });

    const fakeIsrKv = { __brand: 'user-kv' };
    // No `__VOID_ISR_DEPLOYMENT_ID` ⇒ ISR inactive ⇒ ISR_CACHE is a user binding.
    const rawEnv = { ISR_CACHE: fakeIsrKv, API_KEY: 'sk_live' };

    await withRuntimeEnv(rawEnv, async () => {
      await _validateEnvOnce(rawEnv);

      // ISR_CACHE is a normal declared binding here — visible everywhere.
      expect((env as Record<string, unknown>).ISR_CACHE).toEqual(fakeIsrKv);
      expect('ISR_CACHE' in env).toBe(true);
      expect(Object.keys(env)).toContain('ISR_CACHE');

      expect(getRuntimeBinding('ISR_CACHE')).toEqual(fakeIsrKv);
      expect(requireRuntimeBinding('ISR_CACHE')).toEqual(fakeIsrKv);

      expect(env.API_KEY).toBe('sk_live');
    });
  });
});

describe('env proxy with async validators', () => {
  beforeEach(() => {
    resetSchema();
  });

  it('throws a helpful error when sync proxy read hits an async validator (no pre-validation)', () => {
    const asyncValidator = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: async (v: unknown) => {
          await Promise.resolve();
          return typeof v === 'string' ? { value: v } : { issues: [{ message: 'must be string' }] };
        },
      },
    };
    defineEnv({ TOKEN: asyncValidator });
    withRuntimeEnv({ TOKEN: 'value' }, () => {
      expect(() => env.TOKEN).toThrow(/env: Async validator for 'TOKEN'/);
      expect(() => env.TOKEN).toThrow(/_validateEnvOnce/);
    });
  });
});

describe('_getSchemaDefaults (used by plugin and deploy CLI)', () => {
  beforeEach(() => {
    resetSchema();
  });

  it('returns defaults for keys with .default(value)', () => {
    defineEnv({
      PORT: number().default(3000),
      MODE: oneOf(['dev', 'prod'] as const).default('dev'),
      DEBUG: boolean().default(false),
    });
    const defaults = _getSchemaDefaults();
    expect(defaults).toEqual({ PORT: '3000', MODE: 'dev', DEBUG: 'false' });
  });

  it('omits required keys (no default)', () => {
    defineEnv({ STRIPE_KEY: string(), PORT: number().default(3000) });
    const defaults = _getSchemaDefaults();
    expect(defaults).toEqual({ PORT: '3000' });
    expect(defaults).not.toHaveProperty('STRIPE_KEY');
  });

  it('omits .optional() keys without a default (undefined value)', () => {
    defineEnv({ DEBUG: string().optional(), MODE: string().default('x') });
    const defaults = _getSchemaDefaults();
    expect(defaults).toEqual({ MODE: 'x' });
    expect(defaults).not.toHaveProperty('DEBUG');
  });

  it('returns {} when no schema is registered', () => {
    expect(_getSchemaDefaults()).toEqual({});
  });

  it('skips async validators (cannot extract sync default)', () => {
    const asyncWithoutDefault = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: async (v: unknown) => {
          await Promise.resolve();
          return v === undefined ? { value: 'never-used' } : { value: v };
        },
      },
    };
    defineEnv({ ASYNC: asyncWithoutDefault, SYNC: string().default('s') });
    expect(_getSchemaDefaults()).toEqual({ SYNC: 's' });
  });

  it('stringifies non-string default values', () => {
    defineEnv({
      PORT: number().default(8080),
      ON: boolean().default(true),
    });
    const defaults = _getSchemaDefaults();
    expect(defaults.PORT).toBe('8080');
    expect(defaults.ON).toBe('true');
  });
});
