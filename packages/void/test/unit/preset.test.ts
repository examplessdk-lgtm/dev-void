import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'pathe';
import { describe, expect, it, beforeEach, afterEach } from 'vite-plus/test';
import {
  detectPreset,
  formatProjectCommand,
  resolveProjectCommand,
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
