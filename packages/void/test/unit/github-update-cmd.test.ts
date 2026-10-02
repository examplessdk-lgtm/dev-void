import { log } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  PlatformApiError,
  type GithubConnection,
  type PlatformClient,
  type ProjectResponse,
} from '../../src/cli/client.ts';
import { runGithubUpdate } from '../../src/cli/github-cmd.ts';

const projectId = 'proj_test';
const slug = 'my-app';

function makeProject(): ProjectResponse {
  return {
    id: projectId,
    user_id: 'user_1',
    slug,
    type: 'void',
    created_at: '2024-01-01T00:00:00Z',
    custom_domain: null,
    role: 'owner',
  };
}

function makeConnection(overrides: Partial<GithubConnection> = {}): GithubConnection {
  return {
    id: 'conn_1',
    project_id: projectId,
    installation_id: '123456',
    repo_full_name: 'octocat/hello-world',
    branch: 'main',
    build_executor: 'container',
    workflow_path: '.github/workflows/void-deploy.yml',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

type FakeClient = Pick<
  PlatformClient,
  'listProjects' | 'getGithubConnection' | 'updateGithubConnection'
>;

function makeClient(over: Partial<FakeClient> = {}): {
  client: PlatformClient;
  listProjects: ReturnType<typeof vi.fn>;
  getGithubConnection: ReturnType<typeof vi.fn>;
  updateGithubConnection: ReturnType<typeof vi.fn>;
} {
  const listProjects = vi.fn(async () => [makeProject()]);
  const getGithubConnection = vi.fn(async () => makeConnection());
  const updateGithubConnection = vi.fn(async () => makeConnection());
  const client = {
    listProjects,
    getGithubConnection,
    updateGithubConnection,
    ...over,
  } as unknown as PlatformClient;
  return {
    client,
    listProjects: (over.listProjects as ReturnType<typeof vi.fn>) ?? listProjects,
    getGithubConnection:
      (over.getGithubConnection as ReturnType<typeof vi.fn>) ?? getGithubConnection,
    updateGithubConnection:
      (over.updateGithubConnection as ReturnType<typeof vi.fn>) ?? updateGithubConnection,
  };
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let successSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
const originalIsTTY = process.stdin.isTTY;

beforeEach(() => {
  // Force the non-interactive (non-TTY) path so tests never hit clack prompts.
  (process.stdin as { isTTY?: boolean }).isTTY = false;
  // process.exit -> throw so we can assert the error-path exit without killing
  // the test runner.
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  successSpy = vi.spyOn(log, 'success').mockImplementation(() => {});
  infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
  errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
});

afterEach(() => {
  (process.stdin as { isTTY?: boolean }).isTTY = originalIsTTY;
  exitSpy.mockRestore();
  successSpy.mockRestore();
  infoSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('runGithubUpdate (non-TTY)', () => {
  it('updates the executor only, sending just buildExecutor', async () => {
    const { client, updateGithubConnection } = makeClient({
      getGithubConnection: vi.fn(async () => makeConnection({ build_executor: 'container' })),
      updateGithubConnection: vi.fn(async () =>
        makeConnection({ build_executor: 'github_actions' }),
      ),
    });

    await runGithubUpdate('/project', client, {
      subcommand: 'update',
      projectName: slug,
      executor: 'github_actions',
    });

    expect(updateGithubConnection).toHaveBeenCalledTimes(1);
    expect(updateGithubConnection).toHaveBeenCalledWith(projectId, {
      buildExecutor: 'github_actions',
    });
    expect(successSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('updates the branch only, sending just branch', async () => {
    const { client, updateGithubConnection } = makeClient({
      updateGithubConnection: vi.fn(async () => makeConnection({ branch: 'release' })),
    });

    await runGithubUpdate('/project', client, {
      subcommand: 'update',
      projectName: slug,
      branch: 'release',
    });

    expect(updateGithubConnection).toHaveBeenCalledWith(projectId, { branch: 'release' });
    expect(successSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('updates both branch and executor', async () => {
    const { client, updateGithubConnection } = makeClient({
      updateGithubConnection: vi.fn(async () =>
        makeConnection({ branch: 'release', build_executor: 'github_actions' }),
      ),
    });

    await runGithubUpdate('/project', client, {
      subcommand: 'update',
      projectName: slug,
      branch: 'release',
      executor: 'github_actions',
    });

    expect(updateGithubConnection).toHaveBeenCalledWith(projectId, {
      branch: 'release',
      buildExecutor: 'github_actions',
    });
    expect(successSpy).toHaveBeenCalledTimes(1);
  });

  it('updates the workflow only, sending just workflowPath', async () => {
    const { client, updateGithubConnection } = makeClient({
      getGithubConnection: vi.fn(async () => makeConnection()),
      updateGithubConnection: vi.fn(async () =>
        makeConnection({ workflow_path: '.github/workflows/ci.yml' }),
      ),
    });

    await runGithubUpdate('/project', client, {
      subcommand: 'update',
      projectName: slug,
      workflowPath: '.github/workflows/ci.yml',
    });

    expect(updateGithubConnection).toHaveBeenCalledWith(projectId, {
      workflowPath: '.github/workflows/ci.yml',
    });
    expect(successSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('makes no API call when --workflow matches the current workflow_path', async () => {
    const { client, updateGithubConnection } = makeClient({
      getGithubConnection: vi.fn(async () =>
        makeConnection({ workflow_path: '.github/workflows/ci.yml' }),
      ),
    });

    await runGithubUpdate('/project', client, {
      subcommand: 'update',
      projectName: slug,
      workflowPath: '.github/workflows/ci.yml',
    });

    expect(updateGithubConnection).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits(1) with a connect-first message when the project is not connected', async () => {
    const notConnected = new PlatformApiError(
      'Failed to get GitHub connection',
      404,
      JSON.stringify({ error: 'connection not found' }),
    );
    const { client, updateGithubConnection } = makeClient({
      getGithubConnection: vi.fn(async () => {
        throw notConnected;
      }),
    });

    await expect(
      runGithubUpdate('/project', client, {
        subcommand: 'update',
        projectName: slug,
        executor: 'github_actions',
      }),
    ).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'update: This project is not connected to a GitHub repository. Run `void github connect` first.',
    );
    expect(updateGithubConnection).not.toHaveBeenCalled();
  });

  it('exits(1) when no flags are passed (nothing to update) before any API read', async () => {
    const { client, listProjects, getGithubConnection, updateGithubConnection } = makeClient();

    await expect(
      runGithubUpdate('/project', client, {
        subcommand: 'update',
        projectName: slug,
      }),
    ).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'update: Nothing to update. Pass --branch <name>, --executor <container|github_actions>, and/or --workflow <.github/workflows/...>.',
    );
    // The missing-flags guard must run BEFORE project resolution / connection
    // reads, so this usage error never depends on API state.
    expect(listProjects).not.toHaveBeenCalled();
    expect(getGithubConnection).not.toHaveBeenCalled();
    expect(updateGithubConnection).not.toHaveBeenCalled();
  });

  it('reports missing flags (not "connect first") for a disconnected project', async () => {
    // If the guard ran AFTER getGithubConnection, this 404 would surface the
    // "connect first" message instead of the missing-flags usage error.
    const { client, listProjects, getGithubConnection, updateGithubConnection } = makeClient({
      getGithubConnection: vi.fn(async () => {
        throw new PlatformApiError(
          'Failed to get GitHub connection',
          404,
          JSON.stringify({ error: 'connection not found' }),
        );
      }),
    });

    await expect(
      runGithubUpdate('/project', client, {
        subcommand: 'update',
        projectName: slug,
      }),
    ).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'update: Nothing to update. Pass --branch <name>, --executor <container|github_actions>, and/or --workflow <.github/workflows/...>.',
    );
    expect(listProjects).not.toHaveBeenCalled();
    expect(getGithubConnection).not.toHaveBeenCalled();
    expect(updateGithubConnection).not.toHaveBeenCalled();
  });

  it('does not call the API when the requested values equal the current ones', async () => {
    const { client, updateGithubConnection } = makeClient({
      getGithubConnection: vi.fn(async () =>
        makeConnection({ branch: 'main', build_executor: 'container' }),
      ),
    });

    await runGithubUpdate('/project', client, {
      subcommand: 'update',
      projectName: slug,
      branch: 'main',
      executor: 'container',
    });

    expect(updateGithubConnection).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(successSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits(1) when the project slug cannot be resolved', async () => {
    const { client, getGithubConnection } = makeClient({
      listProjects: vi.fn(async () => []),
    });

    await expect(
      runGithubUpdate('/project', client, {
        subcommand: 'update',
        projectName: 'nope',
        executor: 'github_actions',
      }),
    ).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(getGithubConnection).not.toHaveBeenCalled();
  });
});
