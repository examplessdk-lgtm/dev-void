import { beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import worker from '../../src/index.ts';
import type { Env } from '../../src/types.ts';

const JWT_SECRET = 'test-secret-key';
const PROJECT_ID = 'project-id';
let aiToken: string;

beforeAll(async () => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(PROJECT_ID)),
  );
  aiToken = btoa(String.fromCharCode(...signature))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
});

function request(path: string, token: string): Request {
  return new Request(`https://proxy.example.com/sandbox/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: PROJECT_ID, aiToken: token, sandboxId: 'sandbox-id' }),
  });
}

function createEnv(capabilities?: string) {
  const get = vi.fn();
  const env = {
    JWT_SECRET,
    PLATFORM_CAPABILITIES: capabilities,
    ROUTING: { get },
  } as unknown as Env;
  return { env, get };
}

describe.each(['acquire', 'refresh', 'release'])('unavailable Sandbox %s', (path) => {
  it.each([undefined, '{"sandbox":false}', '{"sandbox":true}'])(
    'rejects an authenticated request without accessing Sandbox resources (%s)',
    async (capabilities) => {
      const { env, get } = createEnv(capabilities);
      const response = await worker.fetch(request(path, aiToken), env);
      expect(response.status).toBe(501);
      expect(await response.json()).toEqual({
        error: 'platform capability unavailable',
        capability: 'sandbox',
        message: 'This Void platform does not enable sandbox.',
      });
      expect(get).not.toHaveBeenCalled();
    },
  );

  it('still authenticates before returning the capability response', async () => {
    const { env, get } = createEnv();
    const response = await worker.fetch(request(path, 'invalid-token'), env);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'invalid project token' });
    expect(get).not.toHaveBeenCalled();
  });
});
