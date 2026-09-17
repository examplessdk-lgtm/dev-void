import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';
import { connectCloudflare } from '../../src/cli/cloudflare-connect.ts';

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), select: vi.fn() }));
vi.mock('../../src/cli/cloudflare-auth.ts', () => ({
  createBundledCloudflareAuthRunner: () => vi.fn(),
  ensureCloudflareAuthentication: mocks.authenticate,
}));
vi.mock('@clack/prompts', () => ({
  log: { success: vi.fn(), info: vi.fn() },
  select: mocks.select,
  isCancel: (value: unknown) => typeof value === 'symbol',
}));
let root: string;
beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'void-cf-connect-'));
  for (const name of [
    'CLOUDFLARE_ENV',
    'CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH',
    'CLOUDFLARE_ACCOUNT_ID',
    'CF_ACCOUNT_ID',
  ]) {
    vi.stubEnv(name, '');
  }
  mocks.authenticate.mockResolvedValue({
    accounts: [
      { id: 'one', name: 'One' },
      { id: 'two', name: 'Two' },
    ],
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
it('honors an explicit CI account without prompting and preserves JSONC', async () => {
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'two');
  writeFileSync(
    join(root, 'wrangler.jsonc'),
    '{\n // keep\n "name": "app", "vars": {"EXAMPLE": "yes"}\n}',
  );
  await expect(connectCloudflare(root, false)).resolves.toEqual({ id: 'two', name: 'Two' });
  const config = readFileSync(join(root, 'wrangler.jsonc'), 'utf8');
  expect(config).toContain('// keep');
  expect(config).toContain('"EXAMPLE": "yes"');
  expect(config).toContain('"account_id": "two"');
  expect(mocks.select).not.toHaveBeenCalled();
});
it('accepts trailing commas through the shared Wrangler JSONC parser', async () => {
  writeFileSync(
    join(root, 'wrangler.jsonc'),
    '{\n  // keep the supported JSONC shape\n  "account_id": "one",\n  "vars": { "VALUE": "yes", },\n}\n',
  );

  await expect(connectCloudflare(root, false)).resolves.toEqual({ id: 'one', name: 'One' });
  const config = readFileSync(join(root, 'wrangler.jsonc'), 'utf8');
  expect(config).toContain('// keep the supported JSONC shape');
  expect(config).toContain('"VALUE": "yes"');
  expect(mocks.authenticate).toHaveBeenCalledOnce();
});
it('refuses to silently replace an inaccessible pinned account', async () => {
  writeFileSync(join(root, 'wrangler.jsonc'), '{"account_id":"original"}');
  await expect(connectCloudflare(root, true)).rejects.toThrow('cannot access account original');
  expect(JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')).account_id).toBe(
    'original',
  );
  expect(mocks.select).not.toHaveBeenCalled();
});
it('rejects conflicting account settings before authentication', async () => {
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'two');
  writeFileSync(join(root, 'wrangler.jsonc'), '{"account_id":"one"}');
  await expect(connectCloudflare(root, false)).rejects.toThrow('environment account differs');
  expect(mocks.authenticate).not.toHaveBeenCalled();
});
it('does not guess between accounts in CI', async () => {
  await expect(connectCloudflare(root, false)).rejects.toThrow('Multiple Cloudflare accounts');
  expect(mocks.select).not.toHaveBeenCalled();
});
it('rejects malformed config instead of overwriting it', async () => {
  writeFileSync(join(root, 'wrangler.jsonc'), '{invalid');
  await expect(connectCloudflare(root, true)).rejects.toThrow('Invalid wrangler.jsonc');
  expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')).toBe('{invalid');
  expect(mocks.authenticate).not.toHaveBeenCalled();
});
