import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  _resetUnmaskCacheForTests,
  isLikelySecretKey,
  isLikelySecretValue,
  isUnmaskActive,
  maskValue,
  redactMessage,
  REDACTED,
} from '../../src/shared/env-mask.ts';

/**
 * `env-mask` is the single source of truth for what gets scrubbed out of
 * user-visible env error surfaces. Getting a false negative here leaks a
 * secret into a Discord screenshot; getting a false positive just hides
 * one line of debugging info — so the heuristics err on the redacting side.
 */

describe('isLikelySecretKey', () => {
  it.each([
    ['API_KEY'],
    ['STRIPE_SECRET'],
    ['AUTH_TOKEN'],
    ['DB_PASSWORD'],
    ['SMTP_PASS'],
    ['SMTP_PASSWD'],
    ['GITHUB_CREDENTIAL'],
    ['PRIVATE_RSA'],
    ['AUTH0_ID'],
    ['BEARER_TOKEN'],
    ['APIKEY'],
    ['SENTRY_DSN'],
  ])('flags %s as secret-looking', (name) => {
    expect(isLikelySecretKey(name)).toBe(true);
  });

  it.each([['PORT'], ['NODE_ENV'], ['VITE_TITLE'], ['FEATURE_FLAG'], ['REGION']])(
    'passes %s through as non-secret',
    (name) => {
      expect(isLikelySecretKey(name)).toBe(false);
    },
  );

  it('is case-insensitive', () => {
    expect(isLikelySecretKey('stripe_key')).toBe(true);
    expect(isLikelySecretKey('Bearer')).toBe(true);
  });
});

describe('isLikelySecretValue', () => {
  it.each([
    ['sk_live_abc123'],
    ['sk_test_xyz'],
    ['pk_live_abc'],
    ['ghp_xxxxxxxx'],
    ['AKIAIOSFODNN'],
    ['xoxb-slack-token'],
  ])('flags %s (prefix match)', (v) => {
    expect(isLikelySecretValue(v)).toBe(true);
  });

  it('flags long high-entropy strings regardless of prefix', () => {
    expect(isLikelySecretValue('abcdef1234567890ABCDEF=/+abc')).toBe(true);
  });

  it('passes short/plain values through', () => {
    expect(isLikelySecretValue('3000')).toBe(false);
    expect(isLikelySecretValue('production')).toBe(false);
    expect(isLikelySecretValue('')).toBe(false);
    expect(isLikelySecretValue(undefined)).toBe(false);
  });
});

describe('maskValue', () => {
  it('redacts values whose KEY NAME triggers the heuristic', () => {
    expect(maskValue('STRIPE_KEY', 'sk_test_abc')).toBe(REDACTED);
    expect(maskValue('DATABASE_PASSWORD', 'hunter2')).toBe(REDACTED);
  });

  it('redacts values whose CONTENT looks secret, even on a neutral key', () => {
    // PORT=sk_live_… is the "wrong-file typo" example from the task brief.
    expect(maskValue('PORT', 'sk_live_abc123')).toBe(REDACTED);
    expect(maskValue('SOME_VAR', 'abcdef1234567890ABCDEF0099/+')).toBe(REDACTED);
  });

  it('passes through values on neutral keys with plain content', () => {
    expect(maskValue('PORT', '3000')).toBe('3000');
    expect(maskValue('NODE_ENV', 'production')).toBe('production');
  });

  it('override="public" beats every heuristic', () => {
    expect(maskValue('STRIPE_KEY', 'sk_live_abc', { override: 'public' })).toBe('sk_live_abc');
  });

  it('override="secret" redacts even neutral keys/values', () => {
    expect(maskValue('PORT', '3000', { override: 'secret' })).toBe(REDACTED);
  });

  it('unmask=true disables all redaction', () => {
    expect(maskValue('STRIPE_KEY', 'sk_test', { unmask: true })).toBe('sk_test');
  });

  it('stringifies non-string public values', () => {
    expect(maskValue('PORT', 3000)).toBe('3000');
    expect(maskValue('DEBUG', true)).toBe('true');
  });
});

describe('redactMessage', () => {
  it('replaces raw value substrings when key is secret-looking', () => {
    const msg = redactMessage('STRIPE_KEY', 'sk_live_abc', 'got "sk_live_abc"');
    expect(msg).toBe(`got "${REDACTED}"`);
  });

  it('replaces raw value substrings when value is secret-looking (neutral key)', () => {
    const msg = redactMessage('PORT', 'sk_live_abc123', 'Expected a number, got "sk_live_abc123"');
    expect(msg).toBe(`Expected a number, got "${REDACTED}"`);
  });

  it('leaves plain values alone', () => {
    const msg = redactMessage('PORT', 'abc', 'Expected a number, got "abc"');
    expect(msg).toBe('Expected a number, got "abc"');
  });

  it('respects override="public" even for secret-looking keys', () => {
    const msg = redactMessage('API_KEY', 'sk_live_abc', 'got "sk_live_abc"', {
      override: 'public',
    });
    expect(msg).toBe('got "sk_live_abc"');
  });

  it('respects override="secret" even for plain keys/values', () => {
    const msg = redactMessage('FLAG', 'abc', 'got "abc"', { override: 'secret' });
    expect(msg).toBe(`got "${REDACTED}"`);
  });

  it('is a no-op when unmask=true', () => {
    const msg = redactMessage('STRIPE_KEY', 'sk_live_abc', 'got "sk_live_abc"', { unmask: true });
    expect(msg).toBe('got "sk_live_abc"');
  });
});

describe('isUnmaskActive', () => {
  const origValue = process.env.VOID_ENV_UNMASK;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetUnmaskCacheForTests();
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (origValue === undefined) {
      delete process.env.VOID_ENV_UNMASK;
    } else {
      process.env.VOID_ENV_UNMASK = origValue;
    }
    errSpy.mockRestore();
    _resetUnmaskCacheForTests();
  });

  it('returns false when env var is unset', () => {
    delete process.env.VOID_ENV_UNMASK;
    expect(isUnmaskActive()).toBe(false);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('returns true and prints a one-shot stderr notice when VOID_ENV_UNMASK=1', () => {
    process.env.VOID_ENV_UNMASK = '1';
    expect(isUnmaskActive()).toBe(true);
    // Called again: cached, no second notice.
    expect(isUnmaskActive()).toBe(true);
    expect(errSpy).toHaveBeenCalledTimes(1);
    const printed = String(errSpy.mock.calls[0]?.[0] ?? '');
    expect(printed).toContain('VOID_ENV_UNMASK');
  });

  it('ignores non-"1" values', () => {
    process.env.VOID_ENV_UNMASK = 'true';
    expect(isUnmaskActive()).toBe(false);
  });
});
