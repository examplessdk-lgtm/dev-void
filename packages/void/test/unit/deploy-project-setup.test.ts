import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { PlatformClient } from '../../src/cli/client.ts';

const mockSelect = vi.fn();
const mockText = vi.fn();
const mockConfirm = vi.fn();
const mockStep = vi.fn();
const mockSuccess = vi.fn();
const mockWarn = vi.fn();

vi.mock('@clack/prompts', () => ({
  cancel: vi.fn(),
  confirm: (...args: Array<unknown>) => mockConfirm(...args),
  intro: vi.fn(),
  isCancel: () => false,
  isCI: () => false,
  log: {
    error: vi.fn(),
    info: vi.fn(),
    step: (...args: Array<unknown>) => mockStep(...args),
    success: (...args: Array<unknown>) => mockSuccess(...args),
    warn: (...args: Array<unknown>) => mockWarn(...args),
  },
  note: vi.fn(),
  outro: vi.fn(),
  select: (...args: Array<unknown>) => mockSelect(...args),
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
  text: (...args: Array<unknown>) => mockText(...args),
}));

function createClient() {
  return {
    createProject: vi.fn(),
    listProjects: vi.fn(),
  } as unknown as PlatformClient & {
    createProject: ReturnType<typeof vi.fn>;
    listProjects: ReturnType<typeof vi.fn>;
  };
}

describe('promptDeployProjectConfig', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'void-deploy-project-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'test-app' }));
    mockSelect.mockReset();
    mockText.mockReset();
    mockConfirm.mockReset();
    mockStep.mockReset();
    mockSuccess.mockReset();
    mockWarn.mockReset();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('does not show link option when there are no existing projects', async () => {
    const { promptDeployProjectConfig } = await import('../../src/cli/deploy.ts');
    const client = createClient();
    client.listProjects.mockResolvedValueOnce([]);
    client.createProject.mockResolvedValueOnce({ id: 'proj_new', slug: 'new-app' });
    mockSelect.mockResolvedValueOnce('create');
    mockText.mockResolvedValueOnce('new-app');

    const config = await promptDeployProjectConfig(root, client);

    expect(client.listProjects).toHaveBeenCalledOnce();
    expect(mockSelect).toHaveBeenCalledWith({
      message: 'Set up a Void project for deploy:',
      options: [{ value: 'create', label: 'Create a new project' }],
    });
    expect(client.createProject).toHaveBeenCalledWith('new-app');
    expect(config).toEqual({ projectId: 'proj_new', slug: 'new-app' });
    expect(JSON.parse(readFileSync(join(root, '.void', 'project.json'), 'utf-8'))).toEqual({
      platform: 'void',
      ...config,
    });
  });

  it('accepts short slugs at the prompt and lets the server enforce plan limits', async () => {
    const { promptProjectSlug } = await import('../../src/cli/prompt.ts');
    mockText.mockResolvedValueOnce('valid-app');

    await expect(promptProjectSlug('demo-app')).resolves.toBe('valid-app');

    const promptConfig = mockText.mock.calls[0]?.[0] as {
      validate: (value: string) => string | undefined;
    };
    // Short slugs no longer rejected client-side — plan is checked server-side.
    expect(promptConfig.validate('abc')).toBeUndefined();
    expect(promptConfig.validate('abcde')).toBeUndefined();
    expect(promptConfig.validate('abcdef')).toBeUndefined();
    // Format check still runs locally.
    expect(promptConfig.validate('ABC')).toBe('Slug must be lowercase alphanumeric with dashes.');
    expect(promptConfig.validate('')).toBe('Project slug is required.');
  });

  it('re-prompts when the server rejects a short slug for a free-plan user', async () => {
    const { promptDeployProjectConfig } = await import('../../src/cli/deploy.ts');
    const { PlatformApiError } = await import('../../src/cli/client.ts');
    const client = createClient();
    client.listProjects.mockResolvedValueOnce([]);
    client.createProject
      .mockRejectedValueOnce(
        new PlatformApiError(
          'createProject',
          403,
          JSON.stringify({ error: 'short slugs (5 characters or fewer) require a paid plan' }),
        ),
      )
      .mockResolvedValueOnce({ id: 'proj_new', slug: 'longer-app' });
    mockSelect.mockResolvedValueOnce('create');
    mockText.mockResolvedValueOnce('oxc').mockResolvedValueOnce('longer-app');

    const config = await promptDeployProjectConfig(root, client);

    expect(client.createProject).toHaveBeenNthCalledWith(1, 'oxc');
    expect(client.createProject).toHaveBeenNthCalledWith(2, 'longer-app');
    expect(mockText).toHaveBeenCalledTimes(2);
    expect(config).toEqual({ projectId: 'proj_new', slug: 'longer-app' });
  });

  it('retries when 403 body mentions slug but code is generic', async () => {
    const { promptDeployProjectConfig } = await import('../../src/cli/deploy.ts');
    const { PlatformApiError } = await import('../../src/cli/client.ts');
    const client = createClient();
    client.listProjects.mockResolvedValueOnce([]);
    // Generic top-level error code with the slug detail only in `message` —
    // the retry check must inspect both fields, not short-circuit on `code`.
    client.createProject
      .mockRejectedValueOnce(
        new PlatformApiError(
          'createProject',
          403,
          JSON.stringify({ error: 'forbidden', message: 'slug too short for plan' }),
        ),
      )
      .mockResolvedValueOnce({ id: 'proj_new', slug: 'longer-app' });
    mockSelect.mockResolvedValueOnce('create');
    mockText.mockResolvedValueOnce('oxc').mockResolvedValueOnce('longer-app');

    const config = await promptDeployProjectConfig(root, client);

    expect(client.createProject).toHaveBeenNthCalledWith(1, 'oxc');
    expect(client.createProject).toHaveBeenNthCalledWith(2, 'longer-app');
    expect(config).toEqual({ projectId: 'proj_new', slug: 'longer-app' });
  });

  it('does not retry on non-slug 403 errors (e.g. account suspended)', async () => {
    const { promptDeployProjectConfig } = await import('../../src/cli/deploy.ts');
    const { PlatformApiError } = await import('../../src/cli/client.ts');
    const client = createClient();
    client.listProjects.mockResolvedValueOnce([]);
    client.createProject.mockRejectedValueOnce(
      new PlatformApiError('createProject', 403, JSON.stringify({ error: 'account suspended' })),
    );
    mockSelect.mockResolvedValueOnce('create');
    mockText.mockResolvedValueOnce('my-app');

    await expect(promptDeployProjectConfig(root, client)).rejects.toThrow(PlatformApiError);

    expect(client.createProject).toHaveBeenCalledTimes(1);
    expect(mockText).toHaveBeenCalledTimes(1);
  });

  it('does not show project names when creating with existing projects available', async () => {
    const { promptDeployProjectConfig } = await import('../../src/cli/deploy.ts');
    const client = createClient();
    client.listProjects.mockResolvedValueOnce([
      {
        id: 'proj_1',
        user_id: 'user_1',
        slug: 'existing-app',
        type: 'worker',
        created_at: '2026-04-24T00:00:00.000Z',
        custom_domain: null,
      },
    ]);
    client.createProject.mockResolvedValueOnce({ id: 'proj_new', slug: 'new-app' });
    mockSelect.mockResolvedValueOnce('create');
    mockText.mockResolvedValueOnce('new-app');

    const config = await promptDeployProjectConfig(root, client);

    expect(client.listProjects).toHaveBeenCalledOnce();
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(mockSelect.mock.calls[0]?.[0]).toMatchObject({
      message: 'Set up a Void project for deploy:',
      options: [
        { value: 'create', label: 'Create a new project' },
        { value: 'link', label: 'Link an existing project' },
      ],
    });
    expect(JSON.stringify(mockSelect.mock.calls[0]?.[0])).not.toContain('existing-app');
    expect(config).toEqual({ projectId: 'proj_new', slug: 'new-app' });
  });

  it('only shows project names after the user chooses to link', async () => {
    const { promptDeployProjectConfig } = await import('../../src/cli/deploy.ts');
    const client = createClient();
    client.listProjects.mockResolvedValueOnce([
      {
        id: 'proj_1',
        user_id: 'user_1',
        slug: 'existing-app',
        type: 'worker',
        created_at: '2026-04-24T00:00:00.000Z',
        custom_domain: null,
      },
    ]);
    mockSelect.mockResolvedValueOnce('link').mockResolvedValueOnce('proj_1');
    mockConfirm.mockResolvedValueOnce(true);

    const config = await promptDeployProjectConfig(root, client);

    expect(mockSelect).toHaveBeenCalledTimes(2);
    expect(mockSelect.mock.calls[0]?.[0]).toMatchObject({
      message: 'Set up a Void project for deploy:',
      options: [
        { value: 'create', label: 'Create a new project' },
        { value: 'link', label: 'Link an existing project' },
      ],
    });
    expect(JSON.stringify(mockSelect.mock.calls[0]?.[0])).not.toContain('existing-app');
    expect(mockSelect.mock.calls[1]?.[0]).toMatchObject({
      message: 'Select a project to deploy to:',
      options: [
        {
          label: 'existing-app (existing-app.void.app)',
          value: 'proj_1',
        },
      ],
    });
    expect(mockConfirm).toHaveBeenCalledWith({
      message:
        'Linking to an existing project. Running `void deploy` will overwrite the current deployment of existing-app.void.app. Continue?',
    });
    expect(config).toEqual({ projectId: 'proj_1', slug: 'existing-app' });
    expect(client.createProject).not.toHaveBeenCalled();
  });
});
