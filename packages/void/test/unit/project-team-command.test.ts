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

  it('allows account invitation responses from a direct Cloudflare project directory', async () => {
    const root = rootWithPlatform('cloudflare');
    vi.stubEnv('VOID_TOKEN', 'test-token');
    vi.stubEnv('VOID_API_URL', 'https://api.example.test');
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.endsWith('/me/project-invitations')
        ? Response.json({ invitations: [] })
        : Response.json({});
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runProjectCommand(root, { subcommand: 'team', action: 'pending' });
    await runProjectCommand(root, {
      subcommand: 'team',
      action: 'accept',
      invitationId: 'pinv_1',
    });
    await runProjectCommand(root, {
      subcommand: 'team',
      action: 'decline',
      invitationId: 'pinv_1',
    });

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      'https://api.example.test/me/project-invitations',
      'https://api.example.test/project-invitations/pinv_1/accept',
      'https://api.example.test/project-invitations/pinv_1/decline',
    ]);
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

  it('resolves an explicit project override before acting', async () => {
    const root = rootWithPlatform('void');
    vi.stubEnv('VOID_TOKEN', 'test-token');
    vi.stubEnv('VOID_API_URL', 'https://api.example.test');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json([
          {
            id: 'project_2',
            user_id: 'owner_1',
            slug: 'other-app',
            type: 'worker',
            created_at: '2026-09-17T00:00:00Z',
          },
        ]),
      )
      .mockResolvedValueOnce(
        Response.json({
          members: [{ user: { id: 'owner_1', login: 'owner' }, role: 'owner' }],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runProjectCommand(root, {
      subcommand: 'team',
      action: 'list',
      projectSlug: 'other-app',
    });

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      'https://api.example.test/projects',
      'https://api.example.test/projects/project_2/members',
    ]);
  });
});
