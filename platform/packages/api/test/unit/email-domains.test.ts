import { describe, expect, it } from 'vite-plus/test';
import {
  clearEmailDomainMirror,
  decryptEmailDomainRelaySecret,
  decryptEmailDomainToken,
  encryptEmailDomainRelaySecret,
  encryptEmailDomainToken,
  generateEmailRelaySecret,
  hashEmailRelaySecret,
  writeEmailDomainMirror,
} from '../../src/email/domains.ts';

// 32-byte AES-GCM key, same shape as the integration helpers' key config.
const keyBytes = new Uint8Array(32).fill(7);
let keyBinary = '';
for (const byte of keyBytes) {
  keyBinary += String.fromCharCode(byte);
}
const env = {
  PROJECT_SECRET_ACTIVE_KEY_VERSION: '1',
  PROJECT_SECRET_KEYS_JSON: JSON.stringify({ '1': btoa(keyBinary) }),
};

function createKv(): { store: Map<string, string>; kv: KVNamespace } {
  const store = new Map<string, string>();
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace;
  return { store, kv };
}

describe('email domain credential encryption', () => {
  it('round-trips the customer token under its fixed AAD name', async () => {
    const encrypted = await encryptEmailDomainToken(env, 'proj_1', 'acme.com', 'token-plaintext');
    const decrypted = await decryptEmailDomainToken(env, 'proj_1', 'acme.com', {
      credential_kind: 'api_token',
      token_ciphertext: encrypted.ciphertext,
      token_iv: encrypted.iv,
      token_key_version: encrypted.keyVersion,
    });
    expect(decrypted).toBe('token-plaintext');
  });

  it('round-trips the relay secret under its fixed AAD name', async () => {
    const encrypted = await encryptEmailDomainRelaySecret(
      env,
      'proj_1',
      'acme.com',
      'relay-secret',
    );
    const decrypted = await decryptEmailDomainRelaySecret(env, 'proj_1', 'acme.com', {
      relay_ciphertext: encrypted.ciphertext,
      relay_iv: encrypted.iv,
      relay_key_version: encrypted.keyVersion,
    });
    expect(decrypted).toBe('relay-secret');
  });

  it('refuses to decrypt token ciphertext under the relay AAD name', async () => {
    // The two AAD names are distinct per row, so the token and relay
    // ciphertexts are not interchangeable even within one domain.
    const encrypted = await encryptEmailDomainToken(env, 'proj_1', 'acme.com', 'token-plaintext');
    await expect(
      decryptEmailDomainRelaySecret(env, 'proj_1', 'acme.com', {
        relay_ciphertext: encrypted.ciphertext,
        relay_iv: encrypted.iv,
        relay_key_version: encrypted.keyVersion,
      }),
    ).rejects.toThrow('Failed to decrypt project secret');
  });

  it('binds the ciphertext to the project and the domain', async () => {
    const encrypted = await encryptEmailDomainToken(env, 'proj_1', 'acme.com', 'token-plaintext');
    const row = {
      credential_kind: 'api_token' as const,
      token_ciphertext: encrypted.ciphertext,
      token_iv: encrypted.iv,
      token_key_version: encrypted.keyVersion,
    };
    await expect(decryptEmailDomainToken(env, 'proj_2', 'acme.com', row)).rejects.toThrow(
      'Failed to decrypt project secret',
    );
    await expect(decryptEmailDomainToken(env, 'proj_1', 'other.com', row)).rejects.toThrow(
      'Failed to decrypt project secret',
    );
  });

  it("resolves a platform row to the runtime token without touching the row's triple", async () => {
    const row = {
      credential_kind: 'platform' as const,
      token_ciphertext: null,
      token_iv: null,
      token_key_version: null,
    };
    await expect(
      decryptEmailDomainToken({ ...env, CF_API_TOKEN: 'runtime-token' }, 'proj_1', 'acme.com', row),
    ).resolves.toBe('runtime-token');
    await expect(decryptEmailDomainToken(env, 'proj_1', 'acme.com', row)).rejects.toThrow(
      'CF_API_TOKEN is not configured',
    );
  });

  it('refuses a stored-credential row whose triple is missing', async () => {
    await expect(
      decryptEmailDomainToken(env, 'proj_1', 'acme.com', {
        credential_kind: 'api_token',
        token_ciphertext: null,
        token_iv: null,
        token_key_version: null,
      }),
    ).rejects.toThrow('missing its stored credential');
  });
});

describe('generateEmailRelaySecret', () => {
  it('returns 32 random bytes as unpadded base64url', () => {
    const secret = generateEmailRelaySecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('generates a fresh secret per call', () => {
    expect(generateEmailRelaySecret()).not.toBe(generateEmailRelaySecret());
  });
});

describe('hashEmailRelaySecret', () => {
  it('is sha256 as lowercase hex (NIST vector)', async () => {
    await expect(hashEmailRelaySecret('abc')).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('produces 64 lowercase hex chars for a generated secret', async () => {
    const hex = await hashEmailRelaySecret(generateEmailRelaySecret());
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('email domain ROUTING KV mirror', () => {
  it('writes the wire payload to email-domain:<domain>', async () => {
    const { store, kv } = createKv();
    const relaySecretSha256 = await hashEmailRelaySecret('relay-secret');
    await writeEmailDomainMirror(
      kv,
      {
        domain: 'acme.com',
        project_id: 'proj_1',
        status: 'active',
        relay_worker_name: 'void-email-relay',
        account_id: 'acc_1',
        zone_id: 'zone_1',
        mode: 'apex',
      },
      relaySecretSha256,
    );

    const raw = store.get('email-domain:acme.com');
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual({
      projectId: 'proj_1',
      status: 'active',
      relaySecretSha256,
      relayWorkerName: 'void-email-relay',
      accountId: 'acc_1',
      zoneId: 'zone_1',
      mode: 'apex',
    });
  });

  it('mirrors only the sha256 — never the secret or the token', async () => {
    const { store, kv } = createKv();
    const relaySecret = generateEmailRelaySecret();
    await writeEmailDomainMirror(
      kv,
      {
        domain: 'acme.com',
        project_id: 'proj_1',
        status: 'pending',
        relay_worker_name: null,
        account_id: null,
        zone_id: null,
        mode: 'subdomain',
      },
      await hashEmailRelaySecret(relaySecret),
    );

    const raw = store.get('email-domain:acme.com')!;
    expect(raw).not.toContain(relaySecret);
    // Pending rows mirror explicit nulls; the proxy gates on `status` alone.
    expect(JSON.parse(raw)).toEqual({
      projectId: 'proj_1',
      status: 'pending',
      relaySecretSha256: await hashEmailRelaySecret(relaySecret),
      relayWorkerName: null,
      accountId: null,
      zoneId: null,
      mode: 'subdomain',
    });
  });

  it('clears the key on delete', async () => {
    const { store, kv } = createKv();
    await writeEmailDomainMirror(
      kv,
      {
        domain: 'acme.com',
        project_id: 'proj_1',
        status: 'active',
        relay_worker_name: 'void-email-relay',
        account_id: 'acc_1',
        zone_id: 'zone_1',
        mode: 'apex',
      },
      await hashEmailRelaySecret('relay-secret'),
    );
    await clearEmailDomainMirror(kv, 'acme.com');
    expect(store.has('email-domain:acme.com')).toBe(false);
  });
});
