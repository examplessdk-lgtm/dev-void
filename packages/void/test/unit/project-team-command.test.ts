import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { runProjectCommand } from '../../src/cli/project-cmd.ts';

const roots: Array<string> = [];

function rootWithPlatform(platform: 'cloudflare' | 'void'): string {
  const root = mkdtempSync(join(tmpdir(), 'void-project-team-'));
  roots.push(root);
  mkdirSync(join(root, '.void'));
  writeFileSync(
    join(root, '.void', 'project.json'),
    JSON.stringify({ platform, projectId: 'project_1', slug: 'my-app' }),
  );
  return root;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('project team target selection', () => {
  it('fails clearly before contacting a direct Cloudflare target', async () => {
    await expect(
      runProjectCommand(rootWithPlatform('cloudflare'), {
        subcommand: 'team',
        action: 'list',
        projectSlug: '',
      }),
    ).rejects.toThrow(
      'Teams are available only for projects hosted on a Void platform, not direct Cloudflare deployments',
    );
  });

  it('uses the linked Void platform project for member listing', async () => {
    const root = rootWithPlatform('void');
    vi.stubEnv('VOID_TOKEN', 'test-token');
    vi.stubEnv('VOID_API_URL', 'https://api.example.test');
    const fetchMock = vi.fn(async () =>
      Response.json({
        members: [{ user: { id: 'user_1', login: 'alex' }, role: 'owner' }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runProjectCommand(root, {
      subcommand: 'team',
      action: 'list',
      projectSlug: '',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/projects/project_1/members',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    );
  });
});
