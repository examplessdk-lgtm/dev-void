import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { log } from '@clack/prompts';
import { join } from 'pathslash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  createBundledCloudflareAuthRunner,
  ensureCloudflareAuthentication,
} from '../../src/cli/cloudflare-auth.ts';
import { runCloudflareCommand } from '../../src/cli/cloudflare-cmd.ts';

const fixture = vi.hoisted(() => ({ cli: '' }));
vi.mock('../../src/cli/preset.ts', () => ({
  resolveWranglerArgv: () => [process.execPath, fixture.cli],
}));
const oldSession = {
  loggedIn: true,
  authType: 'OAuth Token',
  email: 'personal@example.test',
  accounts: [{ id: 'individual-id', name: 'Personal account' }],
};
const newSession = {
  loggedIn: true,
  authType: 'OAuth Token',
  email: 'work@example.test',
  accounts: [{ id: 'work-id', name: 'VoidZero' }],
};
type State = {
  oldSession: typeof oldSession;
  nextLogin: typeof newSession;
  plaintext?: typeof oldSession;
  encrypted?: typeof oldSession;
  keyringEnabled: boolean;
  commands: Array<Array<string>>;
  failLogin?: boolean;
  badWhoami?: boolean;
  failKeyring?: boolean;
};
let root: string;
let output: Array<string>;
let stdinTty: PropertyDescriptor | undefined;
let stdoutTty: PropertyDescriptor | undefined;
const read = (): State => JSON.parse(readFileSync(join(root, 'auth-fixture.json'), 'utf8'));
const write = (state: State) =>
  writeFileSync(join(root, 'auth-fixture.json'), JSON.stringify(state));
const pin =
  '{\n // Existing deployment target must not change on login.\n "account_id": "individual-id", "name": "existing-worker"\n}';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'void-auth-session-'));
  fixture.cli = join(import.meta.dirname, '../fixtures/cloudflare-auth-cli.mjs');
  write({
    oldSession,
    nextLogin: newSession,
    plaintext: oldSession,
    keyringEnabled: false,
    commands: [],
  });
  writeFileSync(join(root, 'wrangler.jsonc'), pin);
  for (const key of [
    'CLOUDFLARE_API_TOKEN',
    'CF_API_TOKEN',
    'CLOUDFLARE_API_KEY',
    'CF_API_KEY',
    'CLOUDFLARE_EMAIL',
    'CF_EMAIL',
    'CLOUDFLARE_ACCOUNT_ID',
    'CF_ACCOUNT_ID',
    'CLOUDFLARE_AUTH_USE_KEYRING',
  ]) {
    vi.stubEnv(key, '');
  }
  stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  output = [];
  for (const level of ['info', 'success', 'warn'] as const) {
    vi.spyOn(log, level).mockImplementation((message) => {
      output.push(String(message));
    });
  }
});
afterEach(() => {
  for (const [stream, descriptor] of [
    [process.stdin, stdinTty],
    [process.stdout, stdoutTty],
  ] as const) {
    if (descriptor) {
      Object.defineProperty(stream, 'isTTY', descriptor);
    } else {
      Reflect.deleteProperty(stream, 'isTTY');
    }
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('Cloudflare session switching through the bundled CLI runner', () => {
  it('does not open login in a non-interactive shell', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    await expect(runCloudflareCommand(root, { subcommand: 'login' })).rejects.toThrow(
      'interactive terminal',
    );
    expect(read().commands).toEqual([]);
  });

  it('requires a valid identity response after explicit login', async () => {
    write({ ...read(), badWhoami: true });
    await expect(runCloudflareCommand(root, { subcommand: 'login' })).rejects.toThrow(
      'usable session',
    );
    expect(output.join('\n')).not.toContain('Signed in to Cloudflare');
  });

  it('stops before browser login if persistent secure storage cannot be enabled', async () => {
    write({ ...read(), failKeyring: true });
    await expect(runCloudflareCommand(root, { subcommand: 'login' })).rejects.toThrow(
      'secure Cloudflare credential storage',
    );
    expect(read().commands.some((args) => args[0] === 'login')).toBe(false);
  });

  it('rejects a global API key pair without printing either value', async () => {
    vi.stubEnv('CF_API_KEY', 'synthetic-global-key');
    vi.stubEnv('CLOUDFLARE_EMAIL', 'credential-email@example.test');
    const error = await runCloudflareCommand(root, { subcommand: 'login' }).catch(
      (error) => error as Error,
    );
    expect(String(error)).toContain('CF_API_KEY');
    expect(String(error)).toContain('CLOUDFLARE_EMAIL');
    expect(String(error)).not.toContain('synthetic-global-key');
    expect(String(error)).not.toContain('credential-email@example.test');
    expect(read().commands).toEqual([]);
  });

  it('explicit login replaces an old encrypted session and reports the new identity without retargeting', async () => {
    write({ ...read(), encrypted: oldSession, plaintext: newSession });
    await runCloudflareCommand(root, { subcommand: 'login' });
    expect(read().encrypted?.email).toBe(newSession.email);
    expect(output.join('\n')).toContain(newSession.email);
    expect(output.join('\n')).toContain('OAuth Token');
    expect(output.join('\n')).toContain('work-id');
    expect(output.join('\n')).toContain('individual-id');
    expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')).toBe(pin);
  });

  it.each(['automatic authentication', 'status'])(
    'adopting plaintext through %s persists secure storage for later tooling logins',
    async (mode) => {
      if (mode === 'status') {
        await runCloudflareCommand(root, { subcommand: 'status' });
      } else {
        await ensureCloudflareAuthentication({
          interactive: true,
          requireAccounts: true,
          runWrangler: createBundledCloudflareAuthRunner(root),
        });
      }
      expect(read().keyringEnabled).toBe(true);
      expect(read().commands.some((args) => args[0] === 'login')).toBe(false);
      const env = { ...process.env };
      delete env.CLOUDFLARE_AUTH_USE_KEYRING;
      execFileSync(process.execPath, [fixture.cli, 'login'], { cwd: root, env });
      output = [];
      await runCloudflareCommand(root, { subcommand: 'status' });
      expect(output.join('\n')).toContain(newSession.email);
      expect(output.join('\n')).toContain('work-id');
    },
  );

  it.each(['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN'])(
    'rejects browser login masked by %s without exposing the credential',
    async (name) => {
      vi.stubEnv(name, 'synthetic-secret-never-print');
      const error = await runCloudflareCommand(root, { subcommand: 'login' }).catch(
        (error) => error as Error,
      );
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain(name);
      expect(String(error)).not.toContain('synthetic-secret-never-print');
      expect(read().commands).toEqual([]);
    },
  );

  it('does not announce success or discard the old session when browser login fails', async () => {
    write({ ...read(), encrypted: oldSession, failLogin: true });
    await expect(runCloudflareCommand(root, { subcommand: 'login' })).rejects.toThrow(
      'did not complete',
    );
    expect(read().encrypted).toEqual(oldSession);
    expect(output.join('\n')).not.toContain('Signed in to Cloudflare');
  });

  it('status distinguishes token authentication and a pinned account from the user identity', async () => {
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'synthetic-secret-never-print');
    await runCloudflareCommand(root, { subcommand: 'status' });
    expect(output.join('\n')).toContain('User API Token');
    expect(output.join('\n')).toContain('CLOUDFLARE_API_TOKEN');
    expect(output.join('\n')).toContain('wrangler.jsonc');
    expect(output.join('\n')).not.toContain('synthetic-secret-never-print');
    expect(read().keyringEnabled).toBe(false);
  });
});
