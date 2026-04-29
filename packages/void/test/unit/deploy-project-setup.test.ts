import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformClient } from '../../src/cli/client.ts';

const mockSelect = vi.fn();
const mockText = vi.fn();
const mockStep = vi.fn();
const mockSuccess = vi.fn();
const mockWarn = vi.fn();

vi.mock('@clack/prompts', () => ({
  cancel: vi.fn(),
  confirm: vi.fn(),
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
    expect(JSON.parse(readFileSync(join(root, '.void', 'project.json'), 'utf-8'))).toEqual(config);
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
    expect(config).toEqual({ projectId: 'proj_1', slug: 'existing-app' });
    expect(client.createProject).not.toHaveBeenCalled();
  });
});
