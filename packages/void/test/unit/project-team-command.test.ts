import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  platformCredentialAccount,
  savePlatformConnection,
} from '../../src/cli/platform-registry.ts';
import { runProjectCommand } from '../../src/cli/project-cmd.ts';

const keyring = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), remove: vi.fn() }));
vi.mock('../../src/cli/keyring.ts', () => ({
  readKeyringPassword: keyring.read,
  writeKeyringPassword: keyring.write,
  deleteKeyringPassword: keyring.remove,
}));

const roots: Array<string> = [];

function rootWithPlatform(
  platform: 'cloudflare' | 'void',
  metadata: Record<string, unknown> = {},
): string {
  const root = mkdtempSync(join(tmpdir(), 'void-project-team-'));
  roots.push(root);
  mkdirSync(join(root, '.void'));
  writeFileSync(
    join(root, '.void', 'project.json'),
    JSON.stringify({ platform, projectId: 'project_1', slug: 'my-app', ...metadata }),
  );
  return root;
}

function connect(apiUrl: string, displayName: string): void {
  savePlatformConnection({
    accountId: null,
    apiUrl,
    applicationDomain: null,
    displayName,
    installationId: null,
    kind: 'connected',
    proxyUrl: null,
  });
}

beforeEach(() => {
  keyring.read.mockReset().mockReturnValue(null);
  keyring.write.mockReset().mockReturnValue(true);
  keyring.remove.mockReset().mockReturnValue(true);
});

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
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
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

  it('uses the active connection for account invitations when a Cloudflare project retains another platform link', async () => {
    const platformA = 'https://platform-a.example.test';
    const platformB = 'https://platform-b.example.test';
    const root = rootWithPlatform('cloudflare', { platformUrl: platformA });
    vi.stubEnv('VOID_PLATFORM_REGISTRY_DIR', join(root, 'registry'));
    connect(platformA, 'Platform A');
    connect(platformB, 'Platform B');
    keyring.read.mockImplementation((service: string, account: string) => {
      if (service !== 'dev.void.cli') {
        return null;
      }
      if (account === platformCredentialAccount(platformA)) {
        return 'platform-a-token';
      }
      return account === platformCredentialAccount(platformB) ? 'platform-b-token' : null;
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
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
      `${platformB}/me/project-invitations`,
      `${platformB}/project-invitations/pinv_1/accept`,
      `${platformB}/project-invitations/pinv_1/decline`,
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({
        headers: expect.objectContaining({ Authorization: 'Bearer platform-b-token' }),
      });
    }
  });

  it('keeps an unscoped VOID_TOKEN bound to Void Cloud for account invitations', async () => {
    const platformA = 'https://platform-a.example.test';
    const platformB = 'https://platform-b.example.test';
    const root = rootWithPlatform('cloudflare', { platformUrl: platformA });
    vi.stubEnv('VOID_PLATFORM_REGISTRY_DIR', join(root, 'registry'));
    vi.stubEnv('VOID_TOKEN', 'void-cloud-token');
    vi.stubEnv('VOID_API_URL', undefined);
    connect(platformA, 'Platform A');
    connect(platformB, 'Platform B');
    keyring.read.mockImplementation((service: string, account: string) =>
      service === 'dev.void.cli' && account === platformCredentialAccount(platformB)
        ? 'platform-b-token'
        : null,
    );
    const fetchMock = vi.fn(async () => Response.json({ invitations: [] }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runProjectCommand(root, { subcommand: 'team', action: 'pending' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.void.cloud/me/project-invitations',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer void-cloud-token' }),
      }),
    );
  });

  it('uses the linked Void platform project for member listing', async () => {
    const platformA = 'https://platform-a.example.test';
    const platformB = 'https://platform-b.example.test';
    const root = rootWithPlatform('void', { platformUrl: platformA });
    vi.stubEnv('VOID_PLATFORM_REGISTRY_DIR', join(root, 'registry'));
    connect(platformA, 'Platform A');
    connect(platformB, 'Platform B');
    keyring.read.mockImplementation((service: string, account: string) => {
      if (service !== 'dev.void.cli') {
        return null;
      }
      if (account === platformCredentialAccount(platformA)) {
        return 'platform-a-token';
      }
      return account === platformCredentialAccount(platformB) ? 'platform-b-token' : null;
    });
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
      `${platformA}/projects/project_1/members`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer platform-a-token' }),
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

  it('scrubs control characters from invitation confirmation output', async () => {
    const root = rootWithPlatform('void');
    vi.stubEnv('VOID_TOKEN', 'test-token');
    vi.stubEnv('VOID_API_URL', 'https://api.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          invitation: {
            id: 'pinv_1',
            target: { id: 'user_1', login: 'target', email: 'target\u0007@example.com' },
            role: 'reader',
            created_at: '2026-09-22T00:00:00Z',
            expires_at: '2026-09-29T00:00:00Z',
          },
          refreshed: false,
          delivery: { status: 'sent' },
        }),
      ),
    );
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const output: Array<string> = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });

    await runProjectCommand(root, {
      subcommand: 'team',
      action: 'invite',
      email: 'target@example.com',
      role: 'reader',
      projectSlug: '',
    });

    expect(output.join('')).not.toContain('\u0007');
    expect(output.join('')).toContain('target @example.com');
  });
});
