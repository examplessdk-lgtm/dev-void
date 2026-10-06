import type { ApiEnv } from './env.ts';
import type { ProjectSecret } from './types.ts';

export const BETTER_AUTH_SECRET_NAME = 'BETTER_AUTH_SECRET';

const encoder = new TextEncoder();

type ProjectSecretBindings = Pick<
  ApiEnv['Bindings'],
  'PROJECT_SECRET_KEYS_JSON' | 'PROJECT_SECRET_ACTIVE_KEY_VERSION'
>;

type WorkerSecretBindings = Pick<ApiEnv['Bindings'], 'CF_ACCOUNT_ID' | 'CF_API_TOKEN'>;

type ParsedProjectSecretKeys = Readonly<{
  activeVersion: string;
  rawKeys: Map<string, ArrayBuffer>;
  cryptoKeys: Map<string, Promise<CryptoKey>>;
  credentialKeys: Map<string, Promise<CryptoKey>>;
}>;

let cachedKeyConfig:
  | {
      rawJson: string;
      rawActiveVersion: string;
      parsed: ParsedProjectSecretKeys;
    }
  | undefined;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function getProjectSecretAad(projectId: string, name: string): ArrayBuffer {
  return toArrayBuffer(encoder.encode(`${projectId}:${name}`));
}

function parseProjectSecretKeys(env: ProjectSecretBindings): ParsedProjectSecretKeys {
  if (
    cachedKeyConfig &&
    cachedKeyConfig.rawJson === env.PROJECT_SECRET_KEYS_JSON &&
    cachedKeyConfig.rawActiveVersion === env.PROJECT_SECRET_ACTIVE_KEY_VERSION
  ) {
    return cachedKeyConfig.parsed;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(env.PROJECT_SECRET_KEYS_JSON);
  } catch {
    throw new Error('PROJECT_SECRET_KEYS_JSON must be valid JSON.');
  }

  if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
    throw new Error('PROJECT_SECRET_KEYS_JSON must be a JSON object.');
  }

  const rawKeys = new Map<string, ArrayBuffer>();
  for (const [version, encoded] of Object.entries(parsedJson)) {
    if (typeof encoded !== 'string' || encoded.length === 0) {
      throw new Error(`PROJECT_SECRET_KEYS_JSON entry "${version}" must be a non-empty string.`);
    }

    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(encoded);
    } catch {
      throw new Error(`PROJECT_SECRET_KEYS_JSON entry "${version}" is not valid base64.`);
    }

    if (bytes.byteLength !== 32) {
      throw new Error(`PROJECT_SECRET_KEYS_JSON entry "${version}" must decode to 32 bytes.`);
    }
    rawKeys.set(version, toArrayBuffer(bytes));
  }

  if (rawKeys.size === 0) {
    throw new Error('PROJECT_SECRET_KEYS_JSON must define at least one key.');
  }

  if (!rawKeys.has(env.PROJECT_SECRET_ACTIVE_KEY_VERSION)) {
    throw new Error(
      `PROJECT_SECRET_ACTIVE_KEY_VERSION "${env.PROJECT_SECRET_ACTIVE_KEY_VERSION}" is missing from PROJECT_SECRET_KEYS_JSON.`,
    );
  }

  const parsed: ParsedProjectSecretKeys = {
    activeVersion: env.PROJECT_SECRET_ACTIVE_KEY_VERSION,
    rawKeys,
    cryptoKeys: new Map(),
    credentialKeys: new Map(),
  };
  cachedKeyConfig = {
    rawJson: env.PROJECT_SECRET_KEYS_JSON,
    rawActiveVersion: env.PROJECT_SECRET_ACTIVE_KEY_VERSION,
    parsed,
  };
  return parsed;
}

async function getCryptoKey(env: ProjectSecretBindings, version: string): Promise<CryptoKey> {
  const config = parseProjectSecretKeys(env);
  const existing = config.cryptoKeys.get(version);
  if (existing) {
    return existing;
  }

  const rawKey = config.rawKeys.get(version);
  if (!rawKey) {
    throw new Error(`Unknown project secret key version "${version}".`);
  }

  const promise = crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
  config.cryptoKeys.set(version, promise);
  return promise;
}

export function generateManagedAuthSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type EncryptedPlatformCredential = Readonly<{
  ciphertext: string;
  iv: string;
  keyVersion: string;
}>;

/** Separate platform credential keys from the project's AES key and ciphertext namespace. */
async function platformCredentialKey(
  env: ProjectSecretBindings,
  version: string,
): Promise<CryptoKey> {
  const config = parseProjectSecretKeys(env);
  const rawKey = config.rawKeys.get(version);
  if (!rawKey) {
    throw new Error('Unknown platform credential key version.');
  }
  let key = config.credentialKeys.get(version);
  if (!key) {
    key = crypto.subtle.importKey('raw', rawKey, 'HKDF', false, ['deriveKey']).then((master) =>
      crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: encoder.encode('void-platform-auth-v1'),
          info: encoder.encode('login-client-credentials'),
        },
        master,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      ),
    );
    config.credentialKeys.set(version, key);
  }
  return key;
}

export async function encryptPlatformCredential(
  env: ProjectSecretBindings,
  installationId: string,
  credentialId: string,
  value: string,
): Promise<EncryptedPlatformCredential> {
  const { activeVersion } = parseProjectSecretKeys(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await platformCredentialKey(env, activeVersion);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: encoder.encode(JSON.stringify([installationId, credentialId])),
    },
    key,
    encoder.encode(value),
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
    keyVersion: activeVersion,
  };
}

export async function decryptPlatformCredential(
  env: ProjectSecretBindings,
  installationId: string,
  credentialId: string,
  credential: EncryptedPlatformCredential,
): Promise<string> {
  try {
    const key = await platformCredentialKey(env, credential.keyVersion);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(base64ToBytes(credential.iv)),
        additionalData: encoder.encode(JSON.stringify([installationId, credentialId])),
      },
      key,
      toArrayBuffer(base64ToBytes(credential.ciphertext)),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error(
      'Failed to decrypt platform credential. Check the platform encryption keyring.',
    );
  }
}

export async function encryptProjectSecret(
  env: ProjectSecretBindings,
  projectId: string,
  name: string,
  value: string,
): Promise<{ ciphertext: string; iv: string; keyVersion: string }> {
  const { activeVersion } = parseProjectSecretKeys(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await getCryptoKey(env, activeVersion);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(iv),
      additionalData: getProjectSecretAad(projectId, name),
    },
    key,
    toArrayBuffer(encoder.encode(value)),
  );

  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
    keyVersion: activeVersion,
  };
}

export async function decryptProjectSecret(
  env: ProjectSecretBindings,
  projectId: string,
  row: Pick<ProjectSecret, 'name' | 'ciphertext' | 'iv' | 'key_version'>,
): Promise<string> {
  const key = await getCryptoKey(env, row.key_version);

  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(base64ToBytes(row.iv)),
        additionalData: getProjectSecretAad(projectId, row.name),
      },
      key,
      toArrayBuffer(base64ToBytes(row.ciphertext)),
    );
  } catch {
    throw new Error(`Failed to decrypt project secret "${row.name}".`);
  }

  return new TextDecoder().decode(plaintext);
}

function buildWorkerSecretUrl(
  env: Pick<WorkerSecretBindings, 'CF_ACCOUNT_ID'>,
  dispatchNamespace: string,
  workerName: string,
  secretName?: string,
): string {
  const base =
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}` +
    `/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${workerName}/secrets`;
  return secretName ? `${base}/${encodeURIComponent(secretName)}` : base;
}

export async function putWorkerSecret(
  env: WorkerSecretBindings,
  dispatchNamespace: string,
  workerName: string,
  name: string,
  value: string,
): Promise<void> {
  const cfRes = await fetch(buildWorkerSecretUrl(env, dispatchNamespace, workerName), {
    signal: AbortSignal.timeout(30_000),
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      text: value,
      type: 'secret_text',
    }),
  });

  if (!cfRes.ok) {
    const details = await cfRes.text();
    throw new Error(`failed to set worker secret ${name}: ${details}`);
  }
}

export async function deleteWorkerSecret(
  env: WorkerSecretBindings,
  dispatchNamespace: string,
  workerName: string,
  name: string,
): Promise<void> {
  const cfRes = await fetch(buildWorkerSecretUrl(env, dispatchNamespace, workerName, name), {
    signal: AbortSignal.timeout(30_000),
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
    },
  });

  if (cfRes.status === 404) {
    return;
  }
  if (!cfRes.ok) {
    const details = await cfRes.text();
    throw new Error(`failed to delete worker secret ${name}: ${details}`);
  }
}
