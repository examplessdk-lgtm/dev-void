import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import type { ProjectResponse } from '../../src/cli/client.ts';
import {
  resolveDistDir,
  resolveDeployWranglerCompat,
  resolveStaticBuildCommand,
  resolveWorkerDirName,
} from '../../src/cli/deploy.ts';
import { FRAMEWORK_PRESETS } from '../../src/cli/preset.ts';
import {
  getRequestedProjectSlug,
  inferDefaultSlug,
  resolveProjectBySlug,
} from '../../src/cli/resolve-project.ts';

const tempDirs: Array<string> = [];

describe('getRequestedProjectSlug', () => {
  afterEach(() => {
    delete process.env.VOID_PROJECT;
  });

  it('prefers CLI project slug over env var', () => {
    process.env.VOID_PROJECT = 'from-env';
    expect(getRequestedProjectSlug({ projectSlug: 'from-cli' })).toBe('from-cli');
  });

  it('uses env var when CLI slug is missing', () => {
    process.env.VOID_PROJECT = 'from-env';
    expect(getRequestedProjectSlug()).toBe('from-env');
  });

  it('returns null when no override exists', () => {
    expect(getRequestedProjectSlug()).toBeNull();
  });
});

describe('resolveProjectBySlug', () => {
  it('returns project config for a matching slug', () => {
    const config = resolveProjectBySlug(
      [
        {
          id: 'proj_1',
          user_id: 'user_1',
          slug: 'my-app',
          type: 'worker',
          created_at: '2026-02-15T00:00:00.000Z',
          custom_domain: null,
        },
      ],
      'my-app',
    );

    expect(config).toEqual({
      projectId: 'proj_1',
      slug: 'my-app',
    });
  });

  it('returns null when slug is not found', () => {
    expect(resolveProjectBySlug([], 'missing')).toBeNull();
  });

  it('returns null when slug does not match any project', () => {
    const projects = [
      { id: 'proj_1', slug: 'app-one' },
      { id: 'proj_2', slug: 'app-two' },
    ] as Array<ProjectResponse>;
    expect(resolveProjectBySlug(projects, 'missing')).toBeNull();
  });
});

describe('inferDefaultSlug', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('derives slug from a scoped package name', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@acme/my-app' }));

    expect(inferDefaultSlug(root)).toBe('my-app');
  });

  it('uses fallback values when package name is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({}));

    expect(inferDefaultSlug(root)).toBe('my-app');
  });
});

describe('resolveDistDir', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns dist/ for non-framework deploys', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'dist'), { recursive: true });

    expect(resolveDistDir(root)).toBe(join(root, 'dist'));
  });

  it('returns dist/ for tanstack-start preset', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'dist'), { recursive: true });

    expect(resolveDistDir(root, FRAMEWORK_PRESETS['tanstack-start'])).toBe(join(root, 'dist'));
  });

  it('returns build/ for react-router preset', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'build'), { recursive: true });

    expect(resolveDistDir(root, FRAMEWORK_PRESETS['react-router'])).toBe(join(root, 'build'));
  });

  it('throws with framework-specific message when build dir missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);

    expect(() => resolveDistDir(root, FRAMEWORK_PRESETS['react-router'])).toThrow(
      "deploy: Build output directory 'build' not found",
    );
  });

  it('uses the resolved build command in framework error messages', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);

    expect(() => resolveDistDir(root, FRAMEWORK_PRESETS.sveltekit, 'vp build')).toThrow(
      "Run 'vp build' first.",
    );
  });
});

describe('resolveDeployWranglerCompat', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not pin compatibility_date for non-Cloudflare targets', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);

    expect(resolveDeployWranglerCompat(root, { target: 'node' }, join(root, 'dist', 'ssr'))).toBe(
      undefined,
    );
    expect(existsSync(join(root, 'void.json'))).toBe(false);
  });
});

describe('resolveStaticBuildCommand', () => {
  it('uses inference.build when provided', () => {
    expect(
      resolveStaticBuildCommand(
        {
          buildCommand: 'vite build',
          outputDir: '/tmp/dist',
          appType: 'static',
        },
        'pnpm build',
      ),
    ).toBe('pnpm build');
  });

  it('keeps explicit --dir deploys buildless even when inference.build is set', () => {
    expect(
      resolveStaticBuildCommand(
        {
          buildCommand: null,
          outputDir: '/tmp/dist',
          appType: 'static',
        },
        'pnpm build',
        true,
      ),
    ).toBeNull();
  });
});

describe('resolveWorkerDirName', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns preset worker subdir for react-router', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    const buildDir = join(root, 'build');
    mkdirSync(join(buildDir, 'server'), { recursive: true });

    expect(resolveWorkerDirName(buildDir, FRAMEWORK_PRESETS['react-router'])).toBe('server');
  });

  it('returns preset worker subdir for tanstack-start', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    const dist = join(root, 'dist');
    mkdirSync(join(dist, 'server'), { recursive: true });

    expect(resolveWorkerDirName(dist, FRAMEWORK_PRESETS['tanstack-start'])).toBe('server');
  });

  it('probes for ssr/ without a preset', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    const dist = join(root, 'dist');
    mkdirSync(join(dist, 'ssr'), { recursive: true });

    expect(resolveWorkerDirName(dist)).toBe('ssr');
  });

  it('throws with framework-specific message when worker dir missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    const buildDir = join(root, 'build');
    mkdirSync(buildDir, { recursive: true });

    expect(() => resolveWorkerDirName(buildDir, FRAMEWORK_PRESETS['react-router'])).toThrow(
      "deploy: Worker output 'build/server' not found",
    );
  });

  it('uses the resolved build command when worker output is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    const dist = join(root, 'dist');
    mkdirSync(dist, { recursive: true });

    expect(() => resolveWorkerDirName(dist, FRAMEWORK_PRESETS.sveltekit, 'vp build')).toThrow(
      "Run 'vp build' first.",
    );
  });

  it('throws when no worker dir exists without preset', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    const dist = join(root, 'dist');
    mkdirSync(dist, { recursive: true });

    expect(() => resolveWorkerDirName(dist)).toThrow('Worker output not found');
  });
});
