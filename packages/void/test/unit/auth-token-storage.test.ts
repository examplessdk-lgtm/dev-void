import { afterEach, describe, expect, it } from 'vite-plus/test';
import { saveToken } from '../../src/cli/auth.ts';

afterEach(() => {
  delete process.env.VOID_API_URL;
});

describe('auth token storage', () => {
  it('refuses to fall back to a plaintext config file when the keychain is unavailable', () => {
    process.env.VOID_API_URL = 'https://platform.example.com';

    expect(() =>
      saveToken('secret-token', process.cwd(), {
        keyringSet: () => false,
      }),
    ).toThrow('Refusing to store your platform token in plaintext');
  });
});
