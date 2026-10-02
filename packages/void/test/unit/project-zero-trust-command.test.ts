import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { savePlatformConnection } from '../../src/cli/platform-registry.ts';
import { runProjectCommand } from '../../src/cli/project-cmd.ts';
import { withPlatformDiscovery } from '../helpers/platform-discovery.ts';

const roots: Array<string> = [];

function linkedProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-project-zero-trust-'));
  roots.push(root);
  process.env.VOID_PLATFORM_REGISTRY_DIR = join(root, 'registry');
  savePlatformConnection({
    accountId: null,
    apiUrl: 'https://api.example.test',
    applicationDomain: 'apps.example.test',
    displayName: 'Test platform',
    installationId: null,
    kind: 'connected',
    proxyUrl: 'https://proxy.example.test',
  });
  mkdirSync(join(root, '.void'));
  writeFileSync(
    join(root, '.void', 'project.json'),
    JSON.stringify({
      platform: 'void',
      platformUrl: 'https://api.example.test',
      projectId: 'project_1',
      slug: 'linked-app',
    }),
  );
  return root;
}

afterEach(() => {
  delete process.env.VOID_PLATFORM_REGISTRY_DIR;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('project Zero Trust command', () => {
  it('reports a pending public transition without claiming completion', async () => {
    const root = linkedProject();
    vi.stubEnv('VOID_TOKEN', 'test-token');
    vi.stubEnv('VOID_API_URL', 'https://api.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          ok: true,
          project: {
            project_id: 'project_1',
            desired_protected: false,
            effective_protected: true,
            state: 'reconciling',
            last_error: null,
            updated_at: '2026-09-22T00:00:00Z',
          },
        }),
      ),
    );
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const output: Array<string> = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    await runProjectCommand(root, { subcommand: 'zero-trust', action: 'public', projectSlug: '' });
    expect(output.join('')).toContain('still in progress');
    expect(output.join('')).toContain('void project zero-trust reconcile');
    expect(output.join('')).not.toContain('linked-app is public');
  });
  it('uses VOID_PROJECT without presenting an uninitialized state as public', async () => {
    const root = linkedProject();
    vi.stubEnv('VOID_TOKEN', 'test-token');
    vi.stubEnv('VOID_API_URL', 'https://api.example.test');
    vi.stubEnv('VOID_PROJECT', 'selected-app');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json([
          {
            id: 'project_2',
            user_id: 'owner_1',
            slug: 'selected-app',
            type: 'worker',
            created_at: '2026-09-22T00:00:00Z',
          },
        ]),
      )
      .mockResolvedValueOnce(
        Response.json({
          available: true,
          platformStatus: 'ready',
          protectNewProjects: true,
          project: null,
        }),
      );
    vi.stubGlobal('fetch', withPlatformDiscovery(fetchMock));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const output: Array<string> = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });

    await runProjectCommand(root, {
      subcommand: 'zero-trust',
      action: 'status',
      projectSlug: '',
    });

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      'https://api.example.test/projects',
      'https://api.example.test/projects/project_2/zero-trust',
    ]);
    expect(output.join('')).toContain('Desired: not initialized');
    expect(output.join('')).toContain('Effective: not initialized');
    expect(output.join('')).not.toContain('Desired: public');
  });

  it.each([
    ['invalid_configuration', 'Zero Trust configuration is invalid'],
    ['configuring', 'still applying Zero Trust configuration'],
    ['ready', 'The platform administrator has disabled project Zero Trust.'],
  ])('explains an unavailable %s platform state', async (platformStatus, message) => {
    const root = linkedProject();
    vi.stubEnv('VOID_TOKEN', 'test-token');
    vi.stubEnv('VOID_API_URL', 'https://api.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          available: false,
          platformStatus,
          protectNewProjects: true,
          project: {
            project_id: 'project_1',
            desired_protected: true,
            effective_protected: true,
            state: 'protected',
            last_error: null,
            updated_at: '2026-09-22T00:00:00Z',
          },
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
      subcommand: 'zero-trust',
      action: 'status',
      projectSlug: '',
    });

    const rendered = output.join('');
    expect(rendered).toContain(`Platform: ${platformStatus}`);
    expect(rendered).toContain(message);
    expect(rendered).toContain('Effective: protected');
    // The default for new projects is meaningful only for a readable configuration.
    expect(rendered.includes('Default for new projects: protected')).toBe(
      platformStatus !== 'invalid_configuration',
    );
  });

  it('sends project protection mutations through the command runner', async () => {
    const root = linkedProject();
    vi.stubEnv('VOID_TOKEN', 'test-token');
    vi.stubEnv('VOID_API_URL', 'https://api.example.test');
    const fetchMock = vi.fn(async () =>
      Response.json({
        ok: true,
        project: {
          project_id: 'project_1',
          desired_protected: true,
          effective_protected: true,
          state: 'protected',
          last_error: null,
          updated_at: '2026-09-22T00:00:00Z',
        },
      }),
    );
    vi.stubGlobal('fetch', withPlatformDiscovery(fetchMock));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runProjectCommand(root, {
      subcommand: 'zero-trust',
      action: 'protect',
      projectSlug: '',
    });
    await runProjectCommand(root, {
      subcommand: 'zero-trust',
      action: 'public',
      projectSlug: '',
    });
    await runProjectCommand(root, {
      subcommand: 'zero-trust',
      action: 'reconcile',
      projectSlug: '',
    });

    expect(fetchMock.mock.calls).toEqual([
      [
        'https://api.example.test/projects/project_1/zero-trust',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ protected: true }) }),
      ],
      [
        'https://api.example.test/projects/project_1/zero-trust',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ protected: false }) }),
      ],
      [
        'https://api.example.test/projects/project_1/zero-trust/reconcile',
        expect.objectContaining({ method: 'POST' }),
      ],
    ]);
  });

  it('removes C1 terminal controls from platform errors', async () => {
    const root = linkedProject();
    vi.stubEnv('VOID_TOKEN', 'test-token');
    vi.stubEnv('VOID_API_URL', 'https://api.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          available: true,
          platformStatus: 'ready',
          protectNewProjects: true,
          project: {
            project_id: 'project_1',
            desired_protected: true,
            effective_protected: false,
            state: 'error',
            last_error: 'before\u009b31mafter\u009dtitle',
            updated_at: '2026-09-22T00:00:00Z',
          },
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
      subcommand: 'zero-trust',
      action: 'status',
      projectSlug: '',
    });

    const rendered = output.join('');
    expect(rendered).toContain('before 31mafter title');
    expect(rendered).not.toContain('\u009b');
    expect(rendered).not.toContain('\u009d');
  });
});
