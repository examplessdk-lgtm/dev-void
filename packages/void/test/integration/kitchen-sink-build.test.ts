import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import spawn from 'cross-spawn';
import { join } from 'pathe';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { assembleVoidManifest } from '../../src/cli/deploy.ts';
import { readConfig } from '../../src/config.ts';
import { scanPages } from '../../src/pages/scan.ts';
import { resolveProjectPaths } from '../../src/project-paths.ts';
import { toSlash } from '../../src/shared/utils.ts';

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

    const result = spawn.sync('vp', ['run', '--filter', `./${PLAYGROUND}`, 'build'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, VOID_TOKEN: 'test-leak-token-do-not-use' },
    });

    buildOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(result.status).toBe(0);
  });

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
    // `__VOID_AI_GATEWAY` is a legitimate, non-credential runtime var emitted from
    // `ai.gateway` in void.json (asserted below) — exclude it from the leak filter.
    const leakedKeys = Object.keys(vars).filter(
      (key) => key.startsWith('__VOID_') && key !== '__VOID_AI_GATEWAY',
    );
    expect(leakedKeys).toEqual([]);
  });

  it('binds Workers AI and emits the AI Gateway var for self-host deploys', () => {
    const wranglerConfig = JSON.parse(readFileSync(join(DIST, 'ssr', 'wrangler.json'), 'utf-8'));
    // kitchen-sink imports `void/ai` at request time, so the build infers
    // `needsAI` and injects the Workers AI binding on `command === 'build'`.
    expect(wranglerConfig.ai).toEqual({ binding: 'AI' });
    // `ai.gateway` in playground/kitchen-sink/void.json becomes the runtime var
    // read by the P3 direct backend.
    const vars = (wranglerConfig.vars ?? {}) as Record<string, unknown>;
    expect(vars.__VOID_AI_GATEWAY).toBe('kitchen-sink-gw');
  });

  it('keeps non-internal .env.production vars in dist/ssr/wrangler.json', () => {
    const wranglerConfig = JSON.parse(readFileSync(join(DIST, 'ssr', 'wrangler.json'), 'utf-8'));
    const vars = (wranglerConfig.vars ?? {}) as Record<string, unknown>;
    expect(vars.LEGIT_USER_VAR).toBe('kept');
  });

  it('emits manifest.pages for the Void pages app (scan order, RAW patterns)', async () => {
    // The deploy manifest (carrying `pages`) is a `void deploy` artifact, not a
    // `vite build` output — the `vp build` above never writes it to `dist`. Drive
    // the SAME production seam `runFullDeploy` uses (`assembleVoidManifest`, which
    // owns `scanPages` result → collectPages → manifest.pages) against the real
    // kitchen-sink pages to prove the A3 wiring emits `manifest.pages` for a Void
    // pages app (which includes an ISR page).
    const pg = join(ROOT, PLAYGROUND);
    const deployConfig = readConfig(pg);
    const paths = resolveProjectPaths(pg, deployConfig);
    const pageScan = await scanPages(pg, { output: deployConfig.output, paths });
    const manifest = assembleVoidManifest(pageScan, false, {
      bindings: {
        needsD1: false,
        needsKV: false,
        needsR2: false,
        needsAuth: false,
        needsQueues: false,
        needsAI: false,
        needsSandbox: false,
      },
    });

    // kitchen-sink is a Void pages app → manifest.pages is emitted, in scan order.
    expect(Array.isArray(manifest.pages)).toBe(true);
    expect(manifest.pages!.length).toBeGreaterThan(0);
    // every entry has a string pattern; catch-alls are RAW (`{.+}`/`*`), not normalized away
    for (const p of manifest.pages!) {
      expect(typeof p.pattern).toBe('string');
    }
    // the /revalidate page (export const revalidate = 60) surfaces as an ISR entry
    expect(manifest.pages!.some((p) => p.revalidate != null)).toBe(true);
  });

  it('includes sandbox bindings and container metadata', () => {
    const wranglerConfig = JSON.parse(readFileSync(join(DIST, 'ssr', 'wrangler.json'), 'utf-8'));
    expect(wranglerConfig.compatibility_flags).toContain('nodejs_compat');
    expect(wranglerConfig.durable_objects.bindings).toContainEqual({
      name: 'SANDBOX',
      class_name: 'Sandbox',
    });
    expect(wranglerConfig.containers).toEqual([
      expect.objectContaining({
        name: 'void-sandbox',
        class_name: 'Sandbox',
      }),
    ]);
    expect(wranglerConfig.migrations).toContainEqual({
      tag: 'void-sandbox-v1',
      new_sqlite_classes: ['Sandbox'],
    });
  });
});

function collectFiles(dir: string): Array<string> {
  const files: Array<string> = [];
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
