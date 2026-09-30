import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';

const PACKAGE_ROOT = join(import.meta.dirname, '..', '..');
const CLI_ENTRY = join(PACKAGE_ROOT, 'dist', 'cli', 'cli.mjs');

const roots: Array<string> = [];

function createProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-cli-help-'));
  roots.push(root);
  return root;
}

function runVoid(root: string, args: Array<string>): { output: string; status: number } {
  const res = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: root,
      USERPROFILE: root,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
    },
  });
  return {
    output: `${res.stdout ?? ''}${res.stderr ?? ''}`,
    status: res.status ?? 1,
  };
}

afterEach(() => {
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('void help (subprocess)', () => {
  it.each(['--help', '-h', 'help'])('prints global help through `void %s`', (argument) => {
    const root = createProject();
    const { output, status } = runVoid(root, [argument]);

    expect(status, output).toBe(0);
    expect(output).toContain('void env check');
    expect(output).toContain('void env types');
    expect(output).not.toContain('void env example');
    expect(output).not.toContain('Missing help page');
  });

  it('prints command help through `void help deploy`', () => {
    const root = createProject();
    const { output, status } = runVoid(root, ['help', 'deploy']);

    expect(status).toBe(0);
    expect(output).toContain('void deploy');
    expect(output).toContain('--skip-build');
  });

  it('distinguishes destination auth from Void account auth in help', () => {
    const root = createProject();
    const auth = runVoid(root, ['auth', '--help']);
    const account = runVoid(root, ['account', '--help']);
    expect(auth.status).toBe(0);
    expect(auth.output).toContain('void auth <login|status|logout>');
    expect(auth.output).toContain('--platform <cloudflare|void>');
    expect(account.status).toBe(0);
    expect(account.output).toContain('void account <command>');
    expect(account.output).toContain('link [connection-id]');
  });

  it('does not choose an auth destination silently in a non-interactive project', () => {
    const root = createProject();
    const auth = runVoid(root, ['auth', 'login']);
    expect(auth.status).toBe(1);
    expect(auth.output).toContain('No deployment destination is saved');
    expect(auth.output).toContain('void cloudflare login');
  });

  it('prints command help through `void deploy --help` without running deploy', () => {
    const root = createProject();
    const { output, status } = runVoid(root, ['deploy', '--help']);

    expect(status).toBe(0);
    expect(output).toContain('Offers to link an existing Cloudflare Worker');
    expect(output).toContain('--project <name>');
    expect(output).not.toContain('No auth token found');
    expect(output).not.toContain('Link this project and deploy to Cloudflare');
  });

  it('prints nested command help before parser validation', () => {
    const root = createProject();
    const { output, status } = runVoid(root, ['db', 'execute', '--help']);

    expect(status).toBe(0);
    expect(output).toContain('void db execute <sql>');
    expect(output).toContain('--file <path>');
    expect(output).not.toContain('Usage: void db execute <sql> or void db execute --file <path>');
  });

  it('prints nested command help through group help syntax', () => {
    const root = createProject();
    const { output, status } = runVoid(root, ['db', 'help', 'execute']);

    expect(status).toBe(0);
    expect(output).toContain('Run SQL against the database');
    expect(output).toContain('void db execute --file <path>');
  });

  it('prints project team and ownership-transfer help', () => {
    const root = createProject();
    const team = runVoid(root, ['project', 'team', 'invite', '--help']);
    expect(team.status).toBe(0);
    expect(team.output).toContain('registered email');
    expect(team.output).toContain('--role <role>');

    const owner = runVoid(root, ['platform', 'project', 'owner', '--help']);
    expect(owner.status).toBe(0);
    expect(owner.output).toContain('void platform project owner <id> <userId>');
    expect(owner.output).toContain('--plan');

    const projectZeroTrust = runVoid(root, ['project', 'zero-trust', 'protect', '--help']);
    expect(projectZeroTrust.status).toBe(0);
    expect(projectZeroTrust.output).toContain('void project zero-trust protect');
    expect(projectZeroTrust.output).toContain('--project <name>');

    const platformZeroTrust = runVoid(root, ['platform', 'zero-trust', 'configure', '--help']);
    expect(platformZeroTrust.status).toBe(0);
    expect(platformZeroTrust.output).toContain('--token-stdin');
    expect(platformZeroTrust.output).toContain('--identity-providers <value>');
    expect(platformZeroTrust.output).not.toContain('--account');
    const platformZeroTrustStatus = runVoid(root, ['platform', 'zero-trust', 'status', '--help']);
    expect(platformZeroTrustStatus.status).toBe(0);
    expect(platformZeroTrustStatus.output).toContain('--check');
  });

  it('fails unknown help topics', () => {
    const root = createProject();
    const { output, status } = runVoid(root, ['help', 'missing']);

    expect(status).toBe(1);
    expect(output).toContain('Unknown help topic: missing');
  });

  it('fails unknown nested --help topics', () => {
    const root = createProject();
    const { output, status } = runVoid(root, ['db', 'stats', '--help']);

    expect(status).toBe(1);
    expect(output).toContain('Unknown help topic: db stats');
    expect(output).not.toContain('Manage local and remote database state');
  });
});
