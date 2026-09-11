import { describe, it, expect } from 'vite-plus/test';
import { SUPPORTED_MANIFEST_VERSIONS } from '../../src/types.ts';
import type { DeployManifest } from '../../src/types.ts';

describe('DeployManifest contract', () => {
  it('has a version field', () => {
    const manifest: DeployManifest = {
      version: 3,
      bindings: {},
    };
    expect(manifest.version).toBe(3);
  });

  it('supports version 3', () => {
    expect(SUPPORTED_MANIFEST_VERSIONS).toContain(3);
  });

  it('accepts a full manifest shape', () => {
    const manifest: DeployManifest = {
      version: 3,
      bindings: {
        d1: ['DB'],
        kv: ['KV'],
        r2: ['STORAGE'],
        ai: true,
      },
      migrations: { dialect: 'sqlite', pending: 1 },
      schedules: [{ name: 'cleanup', cron: '0 * * * *' }],
      queues: [{ name: 'emails', bindingName: 'EMAIL_QUEUE' }],
      ssr: true,
      framework: 'sveltekit',
      revalidate: 60,
      prerender: ['/', '/about'],
      assetConfig: {
        not_found_handling: 'single-page-application',
        html_handling: 'auto-trailing-slash',
      },
      vars: { NODE_ENV: 'production' },
      workerMain: 'index.mjs',
      compatibilityDate: '2026-02-24',
      compatibilityFlags: ['nodejs_compat', 'nodejs_als'],
      websocket: {
        routes: [
          {
            pattern: '/chat/:room',
            filePath: 'chat/[room].ws.ts',
            className: 'ChatRoom',
            mode: 'room',
            hasAuthGate: true,
          },
        ],
        classes: ['ChatRoom'],
        migrations: [{ tag: 'ws-v1', newClasses: ['ChatRoom'] }],
      },
    };

    expect(manifest.version).toBe(3);
    expect(manifest.bindings.d1).toEqual(['DB']);
    expect(manifest.migrations?.pending).toBe(1);
    expect(manifest.schedules).toHaveLength(1);
    expect(manifest.queues).toHaveLength(1);
    expect(manifest.workerMain).toBe('index.mjs');
    expect(manifest.compatibilityDate).toBe('2026-02-24');
    expect(manifest.compatibilityFlags).toEqual(['nodejs_compat', 'nodejs_als']);
    expect(manifest.websocket?.classes).toEqual(['ChatRoom']);
  });

  it('rejects unknown manifest versions', () => {
    expect(SUPPORTED_MANIFEST_VERSIONS.includes(999)).toBe(false);
  });
});
