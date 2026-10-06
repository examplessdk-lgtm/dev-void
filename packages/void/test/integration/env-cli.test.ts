import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vite-plus/test';

/**
 * Subprocess coverage for `void env check` and `void env types`. Unit tests
 * cover the individual pieces (schema validation, codegen, dotenv parsing),
 * but only a subprocess invocation exercises the full wiring: argv parsing,
 * the dynamic `import(./env-*.mjs)` chunks resolved from the dist bundle,
 * `await import(envFile)` against an on-disk env.ts, and exit codes — the
 * parts most likely to break silently when dist refactors happen.
 *
 * The fixture env.ts imports `defineEnv` from the dist runtime by absolute
 * file:// URL. That's what the CLI itself loads, so the schema singleton
 * matches end-to-end. A user-shaped `import "void/env"` wouldn't resolve
 * without installing the package into the temp dir, which the subprocess
 * test doesn't need to prove.
 */

const PACKAGE_ROOT = join(import.meta.dirname, '..', '..');
const CLI_ENTRY = join(PACKAGE_ROOT, 'dist', 'cli', 'cli.mjs');
const ENV_PUBLIC_DIST = join(PACKAGE_ROOT, 'dist', 'runtime', 'env-public.mjs');

const roots: Array<string> = [];

function createProject(envSchemaBody?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'void-env-cli-'));
  roots.push(root);
  // Native TypeScript loading follows the same package module rules as .js.
  // Void projects are ESM, so keep the subprocess fixture representative even
  // when the host's temporary directory has no package boundary of its own.
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  if (envSchemaBody !== undefined) {
    const envPublicUrl = pathToFileURL(ENV_PUBLIC_DIST).href;
    writeFileSync(
      join(root, 'env.ts'),
      `import { defineEnv, string, number } from "${envPublicUrl}";\n` +
        `export default defineEnv(${envSchemaBody});\n`,
    );
  }
  return root;
}

function runVoid(
  root: string,
  args: Array<string>,
): { stdout: string; stderr: string; status: number } {
  const res = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: root,
    encoding: 'utf8',
    // Isolate: the env command shouldn't pick up the developer's real env.
    env: {
      PATH: process.env.PATH,
      HOME: root,
      USERPROFILE: root,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
    },
  });
  return {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    status: res.status ?? 1,
  };
}

afterEach(() => {
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('void env check (subprocess)', () => {
  it('exits 0 and reports "nothing to validate" when no env.ts exists', () => {
    const root = createProject();
    const { stdout, status } = runVoid(root, ['env', 'check']);
    expect(status).toBe(0);
    expect(stdout).toContain('No env.ts found');
  });

  it('exits 1 and names the missing key when a required env var is absent', () => {
    const root = createProject('{ STRIPE_KEY: string() }');
    const { stdout, status } = runVoid(root, ['env', 'check']);
    // The command prints clack's `note()` block to stdout on failure.
    expect(status).toBe(1);
    expect(stdout).toContain('Env validation failed');
    expect(stdout).toContain('STRIPE_KEY');
  });

  it('exits 0 when .env satisfies every required key locally', () => {
    const root = createProject('{ STRIPE_KEY: string(), PORT: number() }');
    writeFileSync(join(root, '.env'), 'STRIPE_KEY=sk_dev\nPORT=8080\n');
    const { stdout, status } = runVoid(root, ['env', 'check']);
    expect(status).toBe(0);
    expect(stdout).toContain('Local .env values are valid');
  });

  it('redacts secret-looking values from invalid-env report output', () => {
    // PORT expects a number; the user accidentally pasted an API key.
    // The CLI output must NOT contain the raw token.
    const root = createProject('{ PORT: number() }');
    writeFileSync(join(root, '.env'), 'PORT=sk_live_abc123456\n');
    const { stdout, status } = runVoid(root, ['env', 'check']);
    expect(status).toBe(1);
    expect(stdout).toContain('PORT');
    expect(stdout).not.toContain('sk_live_abc123456');
    expect(stdout).toContain('<redacted>');
  });

  it('rejects legacy .env.local files', () => {
    const root = createProject('{ STRIPE_KEY: string() }');
    writeFileSync(join(root, '.env.local'), 'STRIPE_KEY=sk_dev\n');
    const { stdout, status } = runVoid(root, ['env', 'check']);
    expect(status).toBe(1);
    expect(stdout).toContain('only .env is supported');
    expect(stdout).toContain('.env.local');
  });

  it('rejects names reserved for Void in .env', () => {
    const root = createProject('{ STRIPE_KEY: string() }');
    writeFileSync(join(root, '.env'), 'STRIPE_KEY=sk_dev\n__VOID_PROXY_TOKEN=local\n');
    const { stdout, status } = runVoid(root, ['env', 'check']);
    expect(status).toBe(1);
    expect(stdout).toContain('.env defines names reserved for Void: __VOID_PROXY_TOKEN.');
    expect(stdout).toContain('x-void-dev-trigger');
  });

  it('rejects reserved names written as export K=v or K: v in .env', () => {
    const root = createProject('{ STRIPE_KEY: string() }');
    writeFileSync(
      join(root, '.env'),
      'STRIPE_KEY=sk_dev\nexport __VOID_PROXY_TOKEN=x\n__VOID_EMAIL_FROM: a@b.c\n',
    );
    const { stdout, status } = runVoid(root, ['env', 'check']);
    expect(status).toBe(1);
    // The CLI wraps long lines, so check each name on its own.
    expect(stdout).toContain('.env defines names reserved for Void: __VOID_PROXY_TOKEN,');
    expect(stdout).toContain('__VOID_EMAIL_FROM.');
  });
});

describe('void env types (subprocess)', () => {
  it('writes .void/env.d.ts augmenting void/env and void/handler', () => {
    const root = createProject('{ API_KEY: string() }');
    const { stdout, status } = runVoid(root, ['env', 'types']);
    expect(status).toBe(0);
    expect(stdout).toContain('Wrote');

    const dtsPath = join(root, '.void', 'env.d.ts');
    expect(existsSync(dtsPath)).toBe(true);
    const dts = readFileSync(dtsPath, 'utf-8');
    expect(dts).toContain('declare module "void/env"');
    expect(dts).toContain('declare module "void/handler"');
    expect(dts).toContain('typeof import("../env.ts")');
  });

  it('prints a friendly message and exits 0 when no env.ts exists', () => {
    const root = createProject();
    const { stdout, status } = runVoid(root, ['env', 'types']);
    expect(status).toBe(0);
    expect(stdout).toContain('No env.ts found');
    expect(existsSync(join(root, '.void', 'env.d.ts'))).toBe(false);
  });
});
