import { describe, expect, it } from 'vite-plus/test';
import { hmacSignState, hmacVerifyState } from '../../src/auth/hmac.ts';

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
