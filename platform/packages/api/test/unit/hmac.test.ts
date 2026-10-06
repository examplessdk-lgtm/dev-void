import { describe, expect, it } from 'vite-plus/test';
import { constantTimeEqual, hmacSignState, hmacVerifyState } from '../../src/auth/hmac.ts';

const SECRET = 'test-secret-key-for-hmac';

describe('hmacVerifyState', () => {
  it('verifies a correctly-signed payload', async () => {
    const data = 'eyJoZWxsbyI6IndvcmxkIn0';
    const signature = await hmacSignState(data, SECRET);
    expect(await hmacVerifyState(data, signature, SECRET)).toBe(true);
  });

  it('returns false for a malformed, non-base64url signature ("*") without throwing', async () => {
    await expect(hmacVerifyState('any-data', '*', SECRET)).resolves.toBe(false);
  });

  it('returns false for another non-base64url signature ("@@@") without throwing', async () => {
    await expect(hmacVerifyState('any-data', '@@@', SECRET)).resolves.toBe(false);
  });
});

describe('constantTimeEqual', () => {
  it('returns true for equal strings', () => {
    expect(constantTimeEqual('a1b2c3', 'a1b2c3')).toBe(true);
  });

  it('returns false for different strings of the same length', () => {
    expect(constantTimeEqual('a1b2c3', 'a1b2c4')).toBe(false);
  });

  it('returns false for strings of different lengths', () => {
    expect(constantTimeEqual('a1b2c3', 'a1b2c')).toBe(false);
    expect(constantTimeEqual('', 'a')).toBe(false);
  });

  it('returns true for two empty strings', () => {
    expect(constantTimeEqual('', '')).toBe(true);
  });
});
