import { describe, it, expect, beforeEach } from 'vitest';
import { withRuntimeEnv } from '../../src/runtime/env';
import { boolean, email, json, number, oneOf, string, url } from '../../src/runtime/env-helpers';
import {
  defineEnv,
  env,
  EnvValidationError,
  validateAllEnv,
  _getRegisteredSchema,
  _validateEnvOnce,
} from '../../src/runtime/env-public';

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
});

describe('validateAllEnv (used by dev plugin and CLI)', () => {
  beforeEach(() => {
    resetSchema();
  });

  it('reports valid when all keys satisfied', () => {
    defineEnv({ STRIPE_KEY: string(), PORT: number().default(3000) });
    const report = validateAllEnv({ STRIPE_KEY: 'sk' });
    expect(report.valid).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.invalid).toEqual([]);
  });

  it('separates missing vs invalid', () => {
    defineEnv({
      STRIPE_KEY: string(),
      PORT: number(),
      MODE: oneOf(['a', 'b'] as const),
    });
    const report = validateAllEnv({ PORT: 'not-num', MODE: 'c' });
    expect(report.valid).toBe(false);
    expect(report.missing).toEqual(['STRIPE_KEY']);
    expect(report.invalid.map((i) => i.key).sort()).toEqual(['MODE', 'PORT']);
  });

  it('returns valid=true when no schema registered', () => {
    // After resetSchema(), the schema is empty {} — still counts as registered.
    const report = validateAllEnv({});
    expect(report.valid).toBe(true);
  });
});

describe('_validateEnvOnce (boot-time worker check)', () => {
  beforeEach(() => {
    resetSchema();
  });

  it('passes when env satisfies the schema', () => {
    defineEnv({ STRIPE_KEY: string() });
    expect(() => _validateEnvOnce({ STRIPE_KEY: 'sk_test' })).not.toThrow();
  });

  it('throws EnvValidationError listing all missing/invalid keys', () => {
    defineEnv({ STRIPE_KEY: string(), PORT: number() });
    expect(() => _validateEnvOnce({ PORT: 'oops' })).toThrow(EnvValidationError);
    try {
      _validateEnvOnce({ PORT: 'oops' });
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('STRIPE_KEY is required');
      expect(msg).toContain('PORT');
    }
  });

  it('caches success — schema is only run once per isolate', () => {
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
    _validateEnvOnce({ X: 'hello' });
    _validateEnvOnce({ X: 'hello' });
    _validateEnvOnce({ X: 'hello' });
    expect(calls).toBe(1);
  });

  it('caches failure so repeat calls re-throw the same error', () => {
    defineEnv({ STRIPE_KEY: string() });
    let firstError: unknown;
    let secondError: unknown;
    try {
      _validateEnvOnce({});
    } catch (e) {
      firstError = e;
    }
    try {
      _validateEnvOnce({});
    } catch (e) {
      secondError = e;
    }
    expect(firstError).toBe(secondError);
  });

  it('is a no-op when no schema is registered', () => {
    // resetSchema() registers an empty schema, so re-define with truly empty
    // input to verify the no-validate path still passes.
    defineEnv({});
    expect(() => _validateEnvOnce(undefined)).not.toThrow();
  });

  it('is reset by a new defineEnv call (HMR semantics)', () => {
    defineEnv({ A: string() });
    expect(() => _validateEnvOnce({})).toThrow(EnvValidationError);
    // Re-import / HMR: schema swaps, boot state resets, new env satisfies new schema
    defineEnv({ B: string() });
    expect(() => _validateEnvOnce({ B: 'value' })).not.toThrow();
  });
});
