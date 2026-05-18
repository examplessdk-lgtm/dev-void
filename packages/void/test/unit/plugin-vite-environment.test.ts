import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { resolveConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { voidPlugin } from '../../src/index.ts';

const roots: Array<string> = [];

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-vite-env-'));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      type: 'module',
      dependencies: {},
    }),
  );
  writeFileSync(
    join(root, 'void.json'),
    JSON.stringify({ worker: { compatibility_date: '2026-02-24' } }),
  );
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('voidPlugin Vite environments', () => {
  it('does not create void.json during Vite config resolution', async () => {
    const root = createProjectRoot();
    rmSync(join(root, 'void.json'), { force: true });
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    await resolveConfig(
      {
        root,
        plugins: [voidPlugin()],
      },
      'serve',
      'development',
    );

    expect(existsSync(join(root, 'void.json'))).toBe(false);
  });

  it('does not claim Vite SSR environments configured by test runners', async () => {
    const root = createProjectRoot();
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    await expect(
      resolveConfig(
        {
          root,
          plugins: [voidPlugin()],
          environments: {
            ssr: {
              resolve: {
                external: ['node:fs'],
              },
            },
          },
        },
        'serve',
        'test',
      ),
    ).resolves.toMatchObject({
      environments: {
        void_worker: {
          build: {
            outDir: 'dist/ssr',
          },
        },
      },
    });
  });

  it('clears resolve.external from the worker environment configured by test runners', async () => {
    const root = createProjectRoot();
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const config = await resolveConfig(
      {
        root,
        plugins: [voidPlugin()],
        environments: {
          void_worker: {
            resolve: {
              external: ['node:fs'],
              conditions: ['workerd'],
            },
            build: {
              emptyOutDir: false,
            },
          },
        },
      },
      'serve',
      'test',
    );

    expect(config.environments.void_worker.resolve.external).toEqual([]);
    expect(config.environments.void_worker.resolve.conditions).toContain('workerd');
    expect(config.environments.void_worker.build).toMatchObject({
      emptyOutDir: false,
      outDir: 'dist/ssr',
    });
  });

  it('clears resolve.external from class A framework worker environments', async () => {
    const root = createProjectRoot();
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        type: 'module',
        dependencies: {
          '@tanstack/react-start': '^1.0.0',
        },
      }),
    );

    const config = await resolveConfig(
      {
        root,
        plugins: [voidPlugin()],
        environments: {
          ssr: {
            resolve: {
              external: ['node:fs'],
              conditions: ['workerd'],
            },
          },
        },
      },
      'serve',
      'test',
    );

    expect(config.environments.ssr.resolve.external).toEqual([]);
    expect(config.environments.ssr.resolve.conditions).toContain('workerd');
  });
});
