import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import spawn from 'cross-spawn';
import { join } from 'pathslash';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  type IsolatedPlayground,
} from '../../../../test/integration-helpers.ts';
import { assembleVoidManifest } from '../../src/cli/deploy.ts';
import { readConfig } from '../../src/config.ts';
import { scanPages } from '../../src/pages/scan.ts';
import { resolveProjectPaths } from '../../src/project-paths.ts';
import { toSlash } from '../../src/shared/utils.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SOURCE_PLAYGROUND = 'playground/kitchen-sink';
let playground: IsolatedPlayground;
let dist: string;

let buildOutput = '';

describe('playground/kitchen-sink build', () => {
  beforeAll(() => {
    playground = createIsolatedPlayground(ROOT, SOURCE_PLAYGROUND);
    const pg = playground.root;
    dist = join(pg, 'dist');
    const envProductionPath = join(pg, '.env.production');
    const envLocalPath = join(pg, '.env.local');
    const envProductionLocalPath = join(pg, '.env.production.local');

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
    writeFileSync(
      envLocalPath,
      ['LOCAL_ONLY_VAR=must-not-ship', 'LEGIT_USER_VAR=local-override'].join('\n') + '\n',
    );
    writeFileSync(
      envProductionLocalPath,
      ['PRODUCTION_LOCAL_ONLY_VAR=must-not-ship', 'LEGIT_USER_VAR=production-local-override'].join(
        '\n',
      ) + '\n',
    );

    const result = spawn.sync('vp', ['run', '--filter', `./${playground.workspacePath}`, 'build'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        VOID_TOKEN: 'test-leak-token-do-not-use',
        VOID_CLOUDFLARE_DEPLOY_BUILD: '1',
      },
    });

    buildOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(result.status).toBe(0);
  });

  afterAll(() => {
    playground?.cleanup();
  });

  it('emits the SSR worker entry', () => {
    expect(existsSync(join(dist, 'ssr/index.js'))).toBe(true);
  });

  it('does not warn about unexpected Node.js imports', () => {
    expect(buildOutput).not.toContain('Unexpected Node.js imports for environment "ssr"');
    expect(buildOutput).not.toContain('pg-pool');
  });

  it('does not emit deploy-blocking top-level await in env or db runtime chunks', () => {
    const jsFiles = collectFiles(join(dist, 'ssr')).filter((file) => file.endsWith('.js'));
    const runtimeFiles = jsFiles.filter(
      (file) => /\/env-[^/]+\.js$/.test(file) || /\/_virtual_void-db-[^/]+\.js$/.test(file),
    );

    expect(runtimeFiles.length).toBeGreaterThan(0);

    for (const file of runtimeFiles) {
      expect(readFileSync(file, 'utf8')).not.toContain('await import(');
    }
  });

  it('does not leak __VOID_* credentials into dist/ssr/wrangler.json', () => {
    const wranglerConfig = JSON.parse(readFileSync(join(dist, 'ssr', 'wrangler.json'), 'utf-8'));
    const vars = (wranglerConfig.vars ?? {}) as Record<string, unknown>;
    // These are legitimate, non-credential runtime routing vars for a custom Workers AI
    // binding / AI Gateway. Exclude them from the credential leak filter.
    const allowedRuntimeMarkers = new Set(['__VOID_AI_BINDING', '__VOID_AI_GATEWAY']);
    const leakedKeys = Object.keys(vars).filter(
      (key) => key.startsWith('__VOID_') && !allowedRuntimeMarkers.has(key),
    );
    expect(leakedKeys).toEqual([]);
  });

  it('binds Workers AI and emits the AI Gateway var for self-host deploys', () => {
    const wranglerConfig = JSON.parse(readFileSync(join(dist, 'ssr', 'wrangler.json'), 'utf-8'));
    // kitchen-sink imports `void/ai` at request time, so the build infers
    // `needsAI` and injects the Workers AI binding on `command === 'build'`.
    expect(wranglerConfig.ai).toEqual({ binding: 'AI' });
    // `ai.gateway` in playground/kitchen-sink/void.json becomes the runtime var
    // read by the P3 direct backend.
    const vars = (wranglerConfig.vars ?? {}) as Record<string, unknown>;
    expect(vars.__VOID_AI_GATEWAY).toBe('kitchen-sink-gw');
  });

  it('keeps non-internal .env.production vars in dist/ssr/wrangler.json', () => {
    const wranglerConfig = JSON.parse(readFileSync(join(dist, 'ssr', 'wrangler.json'), 'utf-8'));
    const vars = (wranglerConfig.vars ?? {}) as Record<string, unknown>;
    expect(vars.LEGIT_USER_VAR).toBe('kept');
  });

  it('requires auth deployments to inherit BETTER_AUTH_SECRET without emitting plaintext', () => {
    const wranglerConfig = JSON.parse(readFileSync(join(dist, 'ssr', 'wrangler.json'), 'utf-8'));
    const vars = (wranglerConfig.vars ?? {}) as Record<string, unknown>;
    expect(wranglerConfig.secrets?.required).toContain('BETTER_AUTH_SECRET');
    expect(vars.BETTER_AUTH_SECRET).toBeUndefined();
  });

  it('excludes local dotenv files from Cloudflare deploy worker vars', () => {
    const wranglerConfig = JSON.parse(readFileSync(join(dist, 'ssr', 'wrangler.json'), 'utf-8'));
    const vars = (wranglerConfig.vars ?? {}) as Record<string, unknown>;
    expect(vars.LOCAL_ONLY_VAR).toBeUndefined();
    expect(vars.PRODUCTION_LOCAL_ONLY_VAR).toBeUndefined();
    // A local override must not replace the portable production value.
    expect(vars.LEGIT_USER_VAR).toBe('kept');
  });

  it('emits manifest.pages for the Void pages app (scan order, RAW patterns)', async () => {
    // The deploy manifest (carrying `pages`) is a `void deploy` artifact, not a
    // `vite build` output — the `vp build` above never writes it to `dist`. Drive
    // the SAME production seam `runFullDeploy` uses (`assembleVoidManifest`, which
    // owns `scanPages` result → collectPages → manifest.pages) against the real
    // kitchen-sink pages to prove the A3 wiring emits `manifest.pages` for a Void
    // pages app (which includes an ISR page).
    const pg = playground.root;
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
    const wranglerConfig = JSON.parse(readFileSync(join(dist, 'ssr', 'wrangler.json'), 'utf-8'));
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
