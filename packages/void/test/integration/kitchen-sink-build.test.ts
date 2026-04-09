import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toSlash } from '../../src/shared/utils';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLAYGROUND = 'playground/kitchen-sink';
const DIST = join(ROOT, PLAYGROUND, 'dist');

let buildOutput = '';
// Backup of any pre-existing .env.production so the test doesn't clobber
// developer-local files and can restore exact state on teardown.
// `snapshotTaken` guards against an early beforeAll failure: if we never
// reached the snapshot step, afterAll must leave the file alone entirely
// rather than delete a developer-local copy it never saw.
let envProductionSnapshotTaken = false;
let envProductionOriginal: string | undefined;

describe('playground/kitchen-sink build', () => {
  beforeAll(() => {
    const pg = join(ROOT, PLAYGROUND);

    // Snapshot BEFORE any other filesystem work so a failure in the
    // subsequent rmSync/mkdirSync calls can't leave a developer-local
    // .env.production unbacked-up.
    const envProductionPath = join(pg, '.env.production');
    envProductionOriginal = existsSync(envProductionPath)
      ? readFileSync(envProductionPath, 'utf-8')
      : undefined;
    envProductionSnapshotTaken = true;

    rmSync(join(pg, 'dist'), { recursive: true, force: true });
    rmSync(join(pg, '.void'), { recursive: true, force: true });

    mkdirSync(join(pg, '.void'), { recursive: true });
    writeFileSync(
      join(pg, '.void', 'project.json'),
      JSON.stringify({ projectId: 'test-leak-project-id', slug: 'test-leak' }),
    );

    writeFileSync(
      envProductionPath,
      [
        '__VOID_TOKEN=polluted-from-env-file-do-not-use',
        '__VOID_PROJECT_ID=polluted-project-id',
        '__VOID_REMOTE=1',
        'LEGIT_USER_VAR=kept',
      ].join('\n') + '\n',
    );

    const result = spawn.sync('pnpm', ['--dir', PLAYGROUND, 'build'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, VOID_TOKEN: 'test-leak-token-do-not-use' },
    });

    buildOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(result.status).toBe(0);
  }, 120_000);

  afterAll(() => {
    if (!envProductionSnapshotTaken) {
      return;
    }
    const envProductionPath = join(ROOT, PLAYGROUND, '.env.production');
    if (envProductionOriginal === undefined) {
      rmSync(envProductionPath, { force: true });
    } else {
      writeFileSync(envProductionPath, envProductionOriginal);
    }
  });

  it('emits the SSR worker entry', () => {
    expect(existsSync(join(DIST, 'ssr/index.js'))).toBe(true);
  });

  it('does not warn about unexpected Node.js imports', () => {
    expect(buildOutput).not.toContain('Unexpected Node.js imports for environment "ssr"');
    expect(buildOutput).not.toContain('pg-pool');
  });

  it('does not emit deploy-blocking top-level await in env or db runtime chunks', () => {
    const jsFiles = collectFiles(join(DIST, 'ssr')).filter((file) => file.endsWith('.js'));
    const runtimeFiles = jsFiles.filter(
      (file) => /\/env-[^/]+\.js$/.test(file) || /\/_virtual_void-db-[^/]+\.js$/.test(file),
    );

    expect(runtimeFiles.length).toBeGreaterThan(0);

    for (const file of runtimeFiles) {
      expect(readFileSync(file, 'utf8')).not.toContain('await import(');
    }
  });

  it('does not leak __VOID_* credentials into dist/ssr/wrangler.json', () => {
    const wranglerConfig = JSON.parse(readFileSync(join(DIST, 'ssr', 'wrangler.json'), 'utf-8'));
    const vars = (wranglerConfig.vars ?? {}) as Record<string, unknown>;
    const leakedKeys = Object.keys(vars).filter((key) => key.startsWith('__VOID_'));
    expect(leakedKeys).toEqual([]);
  });

  it('keeps non-internal .env.production vars in dist/ssr/wrangler.json', () => {
    const wranglerConfig = JSON.parse(readFileSync(join(DIST, 'ssr', 'wrangler.json'), 'utf-8'));
    const vars = (wranglerConfig.vars ?? {}) as Record<string, unknown>;
    expect(vars.LEGIT_USER_VAR).toBe('kept');
  });
});

function collectFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = toSlash(join(dir, entry.name));
    if (entry.isDirectory()) {
      files.push(...collectFiles(entryPath));
    } else {
      files.push(entryPath);
    }
  }
  return files;
}
