import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { OperatorClient } from '../../src/cli/operator-client.ts';
import { parsePlatformArgs } from '../../src/cli/platform-args.ts';
import {
  runPlatformAuthConfig,
  waitForPlatformLoginTest,
} from '../../src/cli/platform-auth-config.ts';
import { parsePlatformConfigArgs } from '../../src/cli/platform-config-args.ts';

vi.mock('../../src/cli/operator-auth.ts', () => ({
  resolveOperatorOrigin: () => 'https://api.example.com',
  readOperatorToken: () => 'operator-fixture',
}));
vi.mock('../../src/cli/auth.ts', () => ({ openBrowser: vi.fn() }));
let directory: string;
let calls: Array<{ url: string; body?: Record<string, unknown> }>;
const configuration = {
  id: 'company',
  kind: 'oidc',
  label: 'Company SSO',
  clientId: 'client',
  issuer: 'https://identity.example.com',
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'void-auth-config-'));
  calls = [];
  vi.stubEnv('AUTH_CONFIG_TEST_SECRET', 'fixture-secret-do-not-print');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      const body = init?.body
        ? (JSON.parse(init.body as string) as Record<string, unknown>)
        : undefined;
      calls.push({ url, body });
      if (init?.method === 'GET') {
        return Response.json({
          initialized: true,
          revision: 1,
          methods: [
            { id: 'company', label: 'Company SSO', enabled: true, revision: 1, configuration },
          ],
        });
      }
      return Response.json(
        body?.dryRun
          ? { dryRun: true, action: 'Configure login method', configuration }
          : { id: 'company', revision: 2, enabled: true, activeRevision: 1 },
      );
    }),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe('platform config auth arguments', () => {
  it('separates configuration from administrator session login', () => {
    expect(parsePlatformArgs(['config', 'auth'])).toMatchObject({
      subcommand: 'config',
      action: '',
    });
    expect(parsePlatformArgs(['auth', 'login'])).toMatchObject({
      subcommand: 'operator',
      group: 'auth',
      action: 'login',
    });
    expect(
      parsePlatformArgs([
        'config',
        'auth',
        'add',
        'oidc',
        '--id',
        'company',
        '--file',
        'login.json',
        '--client-secret-env',
        'OIDC_SECRET',
        '--yes',
      ]),
    ).toMatchObject({
      subcommand: 'config',
      action: 'add',
      target: 'oidc',
      id: 'company',
      file: 'login.json',
      clientSecretEnv: 'OIDC_SECRET',
      yes: true,
    });
  });
  it.each(
    [
      ['auth', 'disable'],
      ['auth', 'list', 'extra'],
      ['auth', 'add', 'microsoft'],
      ['auth', 'disable', '../company'],
      ['auth', 'disable', 'company', '--plan', '--yes'],
      ['auth', 'add', 'oidc', '--client-secret', 'literal-secret'],
      ['auth', 'show', 'company', '--file', 'config.json'],
      ['auth', 'disable', 'company', '--id', 'other'],
      ['auth', 'add', 'oidc', '--client-secret-env', 'bad=name'],
      ['auth', 'list', '--json', '--json'],
    ].map((args) => ({ args })),
  )('rejects invalid or unsafe arguments %j', ({ args }) => {
    expect(() => parsePlatformConfigArgs(args)).toThrow();
  });
});

describe('platform config auth execution', () => {
  it('submits a normalized signup policy without requiring a login-method positional argument', async () => {
    const file = join(directory, 'signup.json');
    await writeFile(
      file,
      JSON.stringify({
        mode: 'company',
        connections: ['company'],
        access: false,
        clientSecret: 'unrelated-secret',
      }),
    );
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runPlatformAuthConfig(
      parsePlatformConfigArgs(['auth', 'admission', '--file', file, '--yes', '--json']),
    );
    const changes = calls.filter((call) => call.body);
    expect(changes[1]?.url).toBe('https://api.example.com/operator/v1/config/auth/admission');
    expect(changes[1]?.body).toEqual({
      revision: 1,
      admission: { mode: 'company', connections: ['company'], access: false },
    });
    expect(JSON.stringify(output.mock.calls)).not.toContain('unrelated-secret');
  });
  it('prints exactly one JSON preview without applying a change or displaying its secret', async () => {
    const file = join(directory, 'config.json');
    await writeFile(file, JSON.stringify(configuration));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await runPlatformAuthConfig(
      parsePlatformConfigArgs([
        'auth',
        'configure',
        'company',
        '--file',
        file,
        '--client-secret-env',
        'AUTH_CONFIG_TEST_SECRET',
        '--plan',
        '--json',
      ]),
    );
    expect(output).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(output.mock.calls)).not.toContain('fixture-secret-do-not-print');
    const changes = calls.filter((call) => call.body);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.body).toMatchObject({
      dryRun: true,
      clientSecret: 'fixture-secret-do-not-print',
      revision: 1,
    });
    expect(changes[0]?.url).toBe(
      'https://api.example.com/operator/v1/config/auth/connections/company/configure',
    );
  });
  it('preserves saved secrets when editing nonsecret configuration and previews before applying', async () => {
    const file = join(directory, 'config.json');
    await writeFile(file, JSON.stringify({ label: 'New name' }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await runPlatformAuthConfig(
      parsePlatformConfigArgs(['auth', 'configure', 'company', '--file', file, '--yes', '--json']),
    );
    const changes = calls.filter((call) => call.body);
    expect(changes).toHaveLength(2);
    expect(changes[0]?.body).toMatchObject({ dryRun: true, configuration: { label: 'New name' } });
    expect(changes[1]?.body).not.toHaveProperty('dryRun');
    expect(changes[1]?.body).not.toHaveProperty('clientSecret');
  });
  it('rejects secret-bearing files and conflicting connection IDs before any mutation', async () => {
    const file = join(directory, 'config.json');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await writeFile(file, JSON.stringify({ ...configuration, clientSecret: 'plaintext' }));
    await expect(
      runPlatformAuthConfig(
        parsePlatformConfigArgs(['auth', 'configure', 'company', '--file', file, '--yes']),
      ),
    ).rejects.toThrow('--client-secret-env');
    await writeFile(file, JSON.stringify({ ...configuration, id: 'other' }));
    await expect(
      runPlatformAuthConfig(
        parsePlatformConfigArgs(['auth', 'configure', 'company', '--file', file, '--yes']),
      ),
    ).rejects.toThrow('match');
    expect(calls.every((call) => !call.body)).toBe(true);
  });
  it('lists login methods as readable text, and as JSON only with --json', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runPlatformAuthConfig(parsePlatformConfigArgs(['auth', 'list']));
    const human = output.mock.calls.map(([line]) => String(line)).join('\n');
    expect(human.trimStart().startsWith('{')).toBe(false);
    expect(human).toContain('Initialized: true');
    expect(human).toContain('Company SSO');

    output.mockClear();
    await runPlatformAuthConfig(parsePlatformConfigArgs(['auth', 'list', '--json']));
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      initialized: true,
      methods: [{ id: 'company' }],
    });
  });
  it('does not open or poll a browser test sent by another origin', async () => {
    const client = new OperatorClient('https://api.example.com', 'fixture');
    await expect(
      waitForPlatformLoginTest(client, {
        id: 'test',
        url: 'https://attacker.example.com/auth/test',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      }),
    ).rejects.toThrow('different platform');
    expect(calls).toHaveLength(0);
  });
});
