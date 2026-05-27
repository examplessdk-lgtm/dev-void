import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
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
  const res = spawnSync('node', [CLI_ENTRY, ...args], {
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
  it('prints command help through `void help deploy`', () => {
    const root = createProject();
    const { output, status } = runVoid(root, ['help', 'deploy']);

    expect(status).toBe(0);
    expect(output).toContain('void deploy');
    expect(output).toContain('--skip-build');
  });

  it('prints command help through `void deploy --help` without running deploy', () => {
    const root = createProject();
    const { output, status } = runVoid(root, ['deploy', '--help']);

    expect(status).toBe(0);
    expect(output).toContain('Build and deploy the current project to Void');
    expect(output).toContain('--project <name>');
    expect(output).not.toContain('No auth token found');
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
