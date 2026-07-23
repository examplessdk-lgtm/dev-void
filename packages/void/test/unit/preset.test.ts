import { execSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'pathslash';
import { describe, expect, it, beforeEach, afterEach } from 'vite-plus/test';
import {
  detectPreset,
  formatProjectCommand,
  resolveProjectCommand,
  resolveWranglerArgv,
  resolveWranglerCommand,
} from '../../src/cli/preset.ts';

const TMP = join(import.meta.dirname, '.tmp-preset');

function setupProject(opts: {
  pkg?: Record<string, unknown>;
  dirs?: Array<string>;
  files?: Record<string, string>;
}): string {
  mkdirSync(TMP, { recursive: true });
  if (opts.pkg) {
    writeFileSync(join(TMP, 'package.json'), JSON.stringify(opts.pkg));
  }
  for (const dir of opts.dirs ?? []) {
    mkdirSync(join(TMP, dir), { recursive: true });
  }
  for (const [name, content] of Object.entries(opts.files ?? {})) {
    mkdirSync(join(TMP, name, '..'), { recursive: true });
    writeFileSync(join(TMP, name), content);
  }
  return TMP;
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('detectPreset', () => {
  it('returns explicit dir preset with --dir flag', () => {
    const root = setupProject({});
    const result = detectPreset(root, { dir: 'public' });
    expect(result).toEqual({
      buildCommand: null,
      outputDir: resolve(root, 'public'),
      appType: 'static',
    });
  });

  it('returns SPA mode when --dir and --spa are combined', () => {
    const root = setupProject({});
    const result = detectPreset(root, { dir: 'build', spa: true });
    expect(result).toEqual({
      buildCommand: null,
      outputDir: resolve(root, 'build'),
      appType: 'spa',
    });
  });

  it('detects VitePress (root .vitepress)', () => {
    const root = setupProject({
      pkg: { devDependencies: { vitepress: '^1.0.0' } },
      dirs: ['.vitepress'],
    });
    const result = detectPreset(root);
    expect(result).toEqual({
      buildCommand: 'vitepress build',
      outputDir: resolve(root, '.vitepress/dist'),
      appType: 'static',
    });
  });

  it('detects VitePress (docs/ subdir)', () => {
    const root = setupProject({
      pkg: { devDependencies: { vitepress: '^1.0.0' } },
      dirs: ['docs/.vitepress'],
    });
    const result = detectPreset(root);
    expect(result).toEqual({
      buildCommand: 'vitepress build docs',
      outputDir: resolve(root, 'docs/.vitepress/dist'),
      appType: 'static',
    });
  });

  it('detects Docusaurus', () => {
    const root = setupProject({
      pkg: { dependencies: { '@docusaurus/core': '^3.0.0' } },
    });
    const result = detectPreset(root);
    expect(result).toEqual({
      buildCommand: 'docusaurus build',
      outputDir: resolve(root, 'build'),
      appType: 'static',
    });
  });

  it('returns null when routes/ dir exists (backend files)', () => {
    const root = setupProject({
      pkg: { dependencies: { vite: '^6.0.0' } },
      dirs: ['routes'],
    });
    const result = detectPreset(root);
    expect(result).toBeNull();
  });

  it('returns null when crons/ dir exists (backend files)', () => {
    const root = setupProject({
      pkg: { dependencies: { vite: '^6.0.0' } },
      dirs: ['crons'],
    });
    const result = detectPreset(root);
    expect(result).toBeNull();
  });

  it('returns null when middleware/ dir exists (backend files)', () => {
    const root = setupProject({
      pkg: { dependencies: { vite: '^6.0.0' } },
      dirs: ['middleware'],
    });
    const result = detectPreset(root);
    expect(result).toBeNull();
  });

  it('returns null when pages/ dir exists (backend files)', () => {
    const root = setupProject({
      pkg: { dependencies: { vite: '^6.0.0' } },
      dirs: ['pages'],
    });
    const result = detectPreset(root);
    expect(result).toBeNull();
  });

  it('returns null when queues/ dir exists (backend files)', () => {
    const root = setupProject({
      pkg: { dependencies: { vite: '^6.0.0' } },
      dirs: ['queues'],
    });
    const result = detectPreset(root);
    expect(result).toBeNull();
  });

  it('detects plain Vite SPA (no backend files)', () => {
    const root = setupProject({
      pkg: { dependencies: { vite: '^6.0.0' } },
    });
    const result = detectPreset(root);
    expect(result).toEqual({
      buildCommand: 'vite build',
      outputDir: resolve(root, 'dist'),
      appType: 'spa',
    });
  });

  it('prefers the project build script for plain Vite SPAs', () => {
    const root = setupProject({
      pkg: {
        dependencies: { vite: '^6.0.0' },
        scripts: { build: 'vite build && node scripts/postbuild.js' },
      },
      files: { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" },
    });
    const result = detectPreset(root);
    expect(result).toEqual({
      buildCommand: 'pnpm build',
      outputDir: resolve(root, 'dist'),
      appType: 'spa',
    });
  });

  it('detects Vite+ SPA (no backend files)', () => {
    const root = setupProject({
      pkg: { devDependencies: { 'vite-plus': '^1.0.0' } },
    });
    const result = detectPreset(root);
    expect(result).toEqual({
      buildCommand: 'vp build',
      outputDir: resolve(root, 'dist'),
      appType: 'spa',
    });
  });

  it('detects pre-built dist/index.html as static', () => {
    const root = setupProject({
      files: { 'dist/index.html': '<html></html>' },
    });
    const result = detectPreset(root);
    expect(result).toEqual({
      buildCommand: null,
      outputDir: resolve(root, 'dist'),
      appType: 'static',
    });
  });

  it('detects root index.html as static', () => {
    const root = setupProject({
      files: { 'index.html': '<html></html>' },
    });
    const result = detectPreset(root);
    expect(result).toEqual({
      buildCommand: null,
      outputDir: root,
      appType: 'static',
    });
  });

  it('returns null when no build tool and no output found', () => {
    const root = setupProject({
      pkg: { name: 'empty' },
    });
    const result = detectPreset(root);
    expect(result).toBeNull();
  });
});

describe('project Vite commands', () => {
  it('formats Vite commands with vp when Vite+ is installed', () => {
    const root = setupProject({
      pkg: { devDependencies: { 'vite-plus': '^1.0.0' } },
    });

    expect(formatProjectCommand(root, 'vite dev')).toBe('vp dev');
    expect(formatProjectCommand(root, 'vite build')).toBe('vp build');
    expect(formatProjectCommand(root, 'vite preview')).toBe('vp preview');
  });

  it('resolves Vite+ commands to the local vp binary', () => {
    const root = setupProject({
      pkg: { devDependencies: { 'vite-plus': '^1.0.0' } },
      files: { 'node_modules/.bin/vp': '' },
    });

    expect(resolveProjectCommand(root, 'vite build')).toBe(
      `${join(root, 'node_modules', '.bin', 'vp')} build`,
    );
  });

  it('keeps plain Vite commands unchanged', () => {
    const root = setupProject({
      pkg: { devDependencies: { vite: '^6.0.0' } },
    });

    expect(formatProjectCommand(root, 'vite dev')).toBe('vite dev');
    expect(resolveProjectCommand(root, 'vite build')).toBe('vite build');
  });
});

describe('resolveWranglerCommand', () => {
  it('resolves to the local wrangler binary with the subcommand', () => {
    const root = setupProject({
      pkg: { dependencies: { wrangler: '^4.0.0' } },
      files: { 'node_modules/.bin/wrangler': '' },
    });

    expect(resolveWranglerCommand(root, 'deploy')).toBe(
      `${join(root, 'node_modules', '.bin', 'wrangler')} deploy`,
    );
  });

  it('preserves multi-argument subcommands', () => {
    const root = setupProject({
      pkg: { dependencies: { wrangler: '^4.0.0' } },
      files: { 'node_modules/.bin/wrangler': '' },
    });

    expect(resolveWranglerCommand(root, 'd1 create foo --binding DB --update-config')).toBe(
      `${join(root, 'node_modules', '.bin', 'wrangler')} d1 create foo --binding DB --update-config`,
    );
  });

  it('falls back to a bare wrangler command when no local binary exists', () => {
    const root = setupProject({
      pkg: { dependencies: { wrangler: '^4.0.0' } },
    });

    expect(resolveWranglerCommand(root, 'deploy')).toBe('wrangler deploy');
  });
});

describe('resolveWranglerArgv (module-resolution launcher)', () => {
  it('resolves wrangler via module resolution to [execPath, cli.js] even when the app root has no wrangler (strict pnpm)', () => {
    // wrangler is a dependency of the `void` package, NOT the app root under strict
    // pnpm. Module resolution (relative to preset.ts) still finds it.
    const root = setupProject({ pkg: { name: 'app' } });
    const argv = resolveWranglerArgv(root);
    expect(argv).toHaveLength(2);
    expect(argv[0]).toBe(process.execPath);
    // The resolved entry is wrangler's REAL CLI (`wrangler-dist/cli.js`, its
    // package `main`), NOT the signal-swallowing `bin/wrangler.js` wrapper.
    expect(argv[1].replace(/\\/g, '/')).toMatch(/wrangler\/wrangler-dist\/cli\.js$/);
    expect(argv[1].replace(/\\/g, '/')).not.toMatch(/bin\/wrangler\.js$/);
  });

  it("prefers void's own wrangler over an incompatible app-root wrangler, resolving its REAL cli.js", () => {
    // The app root pins its OWN (potentially older/incompatible) wrangler, and a
    // separate "void-nested" wrangler is resolvable via module resolution. The
    // provisioner targets wrangler 4.107's exact flags/JSON/errors, so void's own
    // wrangler MUST win — the app-root one must not shadow it. The resolved entry
    // is the `main` CLI (`wrangler-dist/cli.js`), NOT the `bin.wrangler` wrapper.
    const root = setupProject({
      pkg: { dependencies: { wrangler: '^3.0.0' } },
      files: {
        'node_modules/wrangler/package.json': JSON.stringify({
          main: './wrangler-dist/cli.js',
          bin: { wrangler: './bin/wrangler.js' },
        }),
        'node_modules/wrangler/wrangler-dist/cli.js': "'use strict';\n",
        'node_modules/wrangler/bin/wrangler.js': '#!/usr/bin/env node\n',
        'void_modules/wrangler/package.json': JSON.stringify({
          main: './wrangler-dist/cli.js',
          bin: { wrangler: './bin/wrangler.js' },
        }),
        'void_modules/wrangler/wrangler-dist/cli.js': "'use strict';\n",
        'void_modules/wrangler/bin/wrangler.js': '#!/usr/bin/env node\n',
      },
    });
    const voidWranglerPkg = join(root, 'void_modules', 'wrangler', 'package.json');
    const argv = resolveWranglerArgv(root, () => voidWranglerPkg);
    // Resolved to void's nested wrangler's REAL CLI, NOT the app-root one, NOT the wrapper.
    expect(argv).toEqual([
      process.execPath,
      join(root, 'void_modules', 'wrangler', 'wrangler-dist', 'cli.js'),
    ]);
  });

  it('resolves the CLI via `exports["."].default` when `main` is absent', () => {
    // A manifest that exposes its CLI only through the `.` export condition still
    // resolves to the real cli.js (never the wrapper).
    const root = setupProject({
      pkg: { name: 'app' },
      files: {
        'void_modules/wrangler/package.json': JSON.stringify({
          exports: { '.': { types: './cli.d.ts', default: './wrangler-dist/cli.js' } },
          bin: { wrangler: './bin/wrangler.js' },
        }),
        'void_modules/wrangler/wrangler-dist/cli.js': "'use strict';\n",
        'void_modules/wrangler/bin/wrangler.js': '#!/usr/bin/env node\n',
      },
    });
    const voidWranglerPkg = join(root, 'void_modules', 'wrangler', 'package.json');
    const argv = resolveWranglerArgv(root, () => voidWranglerPkg);
    expect(argv).toEqual([
      process.execPath,
      join(root, 'void_modules', 'wrangler', 'wrangler-dist', 'cli.js'),
    ]);
  });

  it('falls back to the app-root wrangler only when void resolution fails, resolving its real cli.js', () => {
    const root = setupProject({
      pkg: { dependencies: { wrangler: '^4.0.0' } },
      files: {
        'node_modules/wrangler/package.json': JSON.stringify({
          main: './wrangler-dist/cli.js',
          bin: { wrangler: './bin/wrangler.js' },
        }),
        'node_modules/wrangler/wrangler-dist/cli.js': "'use strict';\n",
        'node_modules/wrangler/bin/wrangler.js': '#!/usr/bin/env node\n',
      },
    });
    // void's own resolution returns undefined → fall back to the app-root probe.
    const argv = resolveWranglerArgv(root, () => undefined);
    expect(argv).toEqual([
      process.execPath,
      join(root, 'node_modules', 'wrangler', 'wrangler-dist', 'cli.js'),
    ]);
  });

  it('never yields a .bin shim argv and throws clearly when wrangler cannot be resolved', () => {
    // A shim/`.cmd`-only layout with module resolution failing must THROW — never
    // degrade to a bare `wrangler` (ENOENT in CI) or a shim Node cannot spawn with
    // shell:false.
    const root = setupProject({
      pkg: { name: 'app' },
      files: { 'node_modules/.bin/wrangler': '#!/bin/sh\n' },
    });
    expect(() => resolveWranglerArgv(root, () => undefined)).toThrow(
      /could not resolve the "wrangler" package/,
    );
  });
});

describe('resolveProjectCommand shell safety (project root with spaces)', () => {
  // A dedicated root whose path contains a space + a single quote — both are
  // shell-significant and must be quoted before the string reaches execSync.
  const SPACED_TMP = join(import.meta.dirname, ".tmp preset o'space");

  beforeEach(() => {
    rmSync(SPACED_TMP, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(SPACED_TMP, { recursive: true, force: true });
  });

  function setupSpacedProject(binName: string): { root: string; binPath: string } {
    mkdirSync(join(SPACED_TMP, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(SPACED_TMP, 'package.json'), JSON.stringify({ dependencies: {} }));
    const binPath = join(SPACED_TMP, 'node_modules', '.bin', binName);
    // Executable that prints a sentinel + its args so we can confirm the shell
    // launched THIS binary (not a truncated `/…/.tmp` prefix from word-splitting).
    writeFileSync(binPath, `#!/bin/sh\necho "VOID_BIN_OK args=$*"\n`);
    chmodSync(binPath, 0o755);
    return { root: SPACED_TMP, binPath };
  }

  it('quotes the resolved executable path so the shell does not word-split it', () => {
    const { root, binPath } = setupSpacedProject('wrangler');
    const cmd = resolveWranglerCommand(root, 'deploy');

    // The bin path (which contains a space and a single quote) must be quoted
    // as a single token, not left as a bare substring the shell would split.
    expect(cmd).not.toBe(`${binPath} deploy`);
    expect(cmd.endsWith(' deploy')).toBe(true);
    if (process.platform === 'win32') {
      expect(cmd).toBe(`"${binPath}" deploy`);
    } else {
      // POSIX single-quote wrap, embedded `'` escaped as '\''.
      expect(cmd).toBe(`'${binPath.replace(/'/g, "'\\''")}' deploy`);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'executes the correct binary through a shell for a spaced root',
    () => {
      const { root } = setupSpacedProject('wrangler');
      const cmd = resolveWranglerCommand(root, 'deploy --dry-run');
      const out = execSync(cmd, { encoding: 'utf-8' });
      expect(out).toContain('VOID_BIN_OK');
      expect(out).toContain('args=deploy --dry-run');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'shell-quotes the vite build path for a spaced root',
    () => {
      const { binPath } = setupSpacedProject('vp');
      // vite-plus present → `vite build` resolves to the local `vp` binary.
      writeFileSync(
        join(SPACED_TMP, 'package.json'),
        JSON.stringify({ devDependencies: { 'vite-plus': '^1.0.0' } }),
      );
      const cmd = resolveProjectCommand(SPACED_TMP, 'vite build');
      expect(cmd).toBe(`'${binPath.replace(/'/g, "'\\''")}' build`);
      const out = execSync(cmd, { encoding: 'utf-8' });
      expect(out).toContain('VOID_BIN_OK');
      expect(out).toContain('args=build');
    },
  );
});
