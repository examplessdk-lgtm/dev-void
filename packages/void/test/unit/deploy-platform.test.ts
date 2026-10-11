import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { assertManagedDurableStateSupported } from '../../src/cli/deploy-managed-framework.ts';
import { resolveDeploymentPlatform, runDeploy } from '../../src/cli/deploy.ts';

const roots: Array<string> = [];

function makeRoot(config?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'void-deploy-platform-'));
  roots.push(root);
  if (config) {
    mkdirSync(join(root, '.void'), { recursive: true });
    writeFileSync(join(root, '.void', 'project.json'), JSON.stringify(config, null, 2) + '\n');
  }
  return root;
}

describe('resolveDeploymentPlatform', () => {
  afterEach(() => {
    while (roots.length > 0) {
      rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  it('lets an explicit platform override the saved preference', () => {
    const root = makeRoot({ platform: 'cloudflare' });
    expect(resolveDeploymentPlatform(root, { platform: 'void' })).toBe('void');
  });

  it('retains Void as the fallback for projects initialized by older SDKs', () => {
    expect(resolveDeploymentPlatform(makeRoot())).toBe('void');
  });

  it('stops with guidance when deployment setup was skipped', async () => {
    const root = makeRoot({ platform: 'none' });
    await expect(runDeploy(root)).rejects.toThrow(
      'Pass `--platform cloudflare` or `--platform void` to choose a destination.',
    );
  });

  it('rejects typed Durable State before a managed-platform build', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'durable-objects'));
    writeFileSync(join(root, 'durable-objects', 'counter.ts'), 'export default {}');

    expect(() => assertManagedDurableStateSupported(root)).toThrow(
      'Deploy to your own Cloudflare account with `void deploy --platform cloudflare`',
    );
  });
});
