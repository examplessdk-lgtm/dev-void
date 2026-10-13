import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { savePlatformToken } from '../../src/cli/auth.ts';
import { platformCredentialAccount } from '../../src/cli/platform-registry.ts';

const keyringWrite = vi.hoisted(() => vi.fn(() => true));
vi.mock('../../src/cli/keyring.ts', () => ({
  readKeyringPassword: () => null,
  writeKeyringPassword: keyringWrite,
  deleteKeyringPassword: () => false,
}));

afterEach(() => {
  delete process.env.VOID_API_URL;
});

describe('auth token storage', () => {
  it('stores explicit connection credentials under that origin despite an environment override', () => {
    process.env.VOID_API_URL = 'https://other.example.com';
    savePlatformToken('secret-token', 'https://platform.example.com');
    expect(keyringWrite).toHaveBeenCalledWith(
      'dev.void.cli',
      platformCredentialAccount('https://platform.example.com'),
      'secret-token',
    );
  });
  it('refuses to fall back to a plaintext config file when the keychain is unavailable', () => {
    process.env.VOID_API_URL = 'https://platform.example.com';
    keyringWrite.mockReturnValueOnce(false);

    expect(() => savePlatformToken('secret-token', 'https://platform.example.com')).toThrow(
      'Refusing to store your platform token in plaintext',
    );
  });
});
