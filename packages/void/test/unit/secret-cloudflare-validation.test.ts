import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { number, string } from '../../src/runtime/env-helpers.ts';
import { defineEnv } from '../../src/runtime/env-public.ts';

const cloudflare = vi.hoisted(() => ({
  put: vi.fn(),
  sync: vi.fn(),
  resolve: vi.fn(() => ({ workerName: 'app' })),
}));

vi.mock('../../src/cli/cloudflare-operations.ts', () => ({
  deleteCloudflareSecret: vi.fn(),
  listCloudflareSecrets: vi.fn(),
  putCloudflareSecret: cloudflare.put,
  resolveCloudflareOperationContext: cloudflare.resolve,
  syncCloudflareSecrets: cloudflare.sync,
}));

import { runSecretCommand } from '../../src/cli/secret.ts';

const roots: Array<string> = [];

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-secret-validation-'));
  roots.push(root);
  mkdirSync(join(root, '.void'), { recursive: true });
  writeFileSync(join(root, '.void/project.json'), '{"platform":"cloudflare"}\n');
  writeFileSync(join(root, 'env.ts'), 'export {};\n');
  return root;
}

beforeEach(() => {
  defineEnv({});
  cloudflare.put.mockReset();
  cloudflare.sync.mockReset();
  cloudflare.resolve.mockClear();
});

afterEach(() => {
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('direct Cloudflare secret validation', () => {
  it.each([
    ['an undeclared name', 'OTHER', 'value', 'OTHER is not declared in env.ts'],
    [
      'a client-exposed name',
      'VITE_API_URL',
      'https://example.com',
      'VITE_API_URL is client-exposed',
    ],
  ])('rejects %s before invoking Wrangler', async (_label, name, value, message) => {
    const root = project();
    defineEnv({ API_TOKEN: string(), VITE_API_URL: string() });

    await expect(runSecretCommand(root, { action: 'put', name, value })).rejects.toThrow(message);
    expect(cloudflare.put).not.toHaveBeenCalled();
    expect(cloudflare.sync).not.toHaveBeenCalled();
  });

  it('rejects invalid bulk values before invoking Wrangler', async () => {
    const root = project();
    const dotenv = join(root, 'production.env');
    writeFileSync(dotenv, 'PORT=not-a-number\n');
    defineEnv({ PORT: number() });

    await expect(runSecretCommand(root, { action: 'sync', file: dotenv })).rejects.toThrow(
      'PORT failed env.ts validation',
    );
    expect(cloudflare.put).not.toHaveBeenCalled();
    expect(cloudflare.sync).not.toHaveBeenCalled();
  });

  it('uploads a declared server value after it passes validation', async () => {
    const root = project();
    defineEnv({ API_TOKEN: string() });

    await runSecretCommand(root, { action: 'put', name: 'API_TOKEN', value: 'secret' });

    expect(cloudflare.put).toHaveBeenCalledWith({ workerName: 'app' }, 'API_TOKEN', 'secret');
  });
});
