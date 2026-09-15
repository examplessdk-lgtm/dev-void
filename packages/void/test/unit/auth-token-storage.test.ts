import { afterEach, describe, expect, it } from 'vite-plus/test';
import { savePlatformToken, saveToken } from '../../src/cli/auth.ts';
import { platformCredentialAccount } from '../../src/cli/platform-registry.ts';

afterEach(() => {
  delete process.env.VOID_API_URL;
});

describe('auth token storage', () => {
  it('stores explicit connection credentials under that origin despite an environment override', () => {
    process.env.VOID_API_URL = 'https://other.example.com';
    let account: string | undefined;
    savePlatformToken('secret-token', 'https://platform.example.com', {
      keyringSet: (value) => {
        account = value;
        return true;
      },
    });
    expect(account).toBe(platformCredentialAccount('https://platform.example.com'));
  });
  it('refuses to fall back to a plaintext config file when the keychain is unavailable', () => {
    process.env.VOID_API_URL = 'https://platform.example.com';

    expect(() =>
      saveToken('secret-token', process.cwd(), {
        keyringSet: () => false,
      }),
    ).toThrow('Refusing to store your platform token in plaintext');
  });
});
