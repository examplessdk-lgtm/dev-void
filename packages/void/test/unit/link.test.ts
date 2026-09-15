import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import { join } from 'pathslash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { savePlatformConnection } from '../../src/cli/platform-registry.ts';

const mockCancel = vi.fn();
const mockConfirm = vi.fn();
const mockGetToken = vi.fn();
const mockListProjects = vi.fn();
const mockOutro = vi.fn();
const mockReadLegacyHostedPlatformSelection = vi.fn();
const mockSelect = vi.fn();

const existingProject = {
  id: 'proj_1',
  user_id: 'user_1',
  slug: 'existing-app',
  type: 'worker',
  created_at: '2026-05-27T00:00:00.000Z',
  custom_domain: null,
};

vi.mock('@clack/prompts', () => ({
  cancel: (...args: Array<unknown>) => mockCancel(...args),
  confirm: (...args: Array<unknown>) => mockConfirm(...args),
  intro: vi.fn(),
  isCancel: (value: unknown) => value === Symbol.for('cancel'),
  log: { warn: vi.fn() },
  outro: (...args: Array<unknown>) => mockOutro(...args),
  select: (...args: Array<unknown>) => mockSelect(...args),
}));

vi.mock('../../src/cli/auth', () => ({
  getSiteDomain: () => 'void.app',
  getToken: (...args: Array<unknown>) => mockGetToken(...args),
}));

vi.mock('../../src/cli/client', () => ({
  PlatformClient: class {
    readonly apiUrl = 'https://api.void.cloud';

    listProjects(...args: Array<unknown>) {
      return mockListProjects(...args);
    }
  },
}));

vi.mock('../../src/cli/hosted-platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/hosted-platform.ts')>()),
  readLegacyHostedPlatformSelection: () => mockReadLegacyHostedPlatformSelection(),
}));

// Disable colors so assertions can match plain strings without ANSI escape codes.
vi.mock('picocolors', () => {
  const id = (s: string) => s;
  return {
    default: {
      blue: id,
      bold: id,
      cyan: id,
      dim: id,
      gray: id,
      green: id,
      red: id,
      reset: id,
      white: id,
      yellow: id,
    },
  };
});

describe('runLink', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'void-link-'));
    process.env.VOID_PLATFORM_REGISTRY_DIR = join(root, 'registry');
    savePlatformConnection({
      accountId: null,
      apiUrl: 'https://api.void.cloud',
      applicationDomain: 'void.app',
      displayName: 'Void Cloud',
      installationId: null,
      kind: 'connected',
      proxyUrl: 'https://proxy.void.cloud',
    });
    mockCancel.mockReset();
    mockConfirm.mockReset();
    mockGetToken.mockReset();
    mockListProjects.mockReset();
    mockOutro.mockReset();
    mockReadLegacyHostedPlatformSelection.mockReset();
    mockReadLegacyHostedPlatformSelection.mockReturnValue(null);
    mockSelect.mockReset();
  });

  afterEach(() => {
    delete process.env.VOID_PLATFORM_REGISTRY_DIR;
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('confirms before interactively linking an existing project', async () => {
    const { runLink } = await import('../../src/cli/link.ts');
    mockGetToken.mockReturnValue('token_123');
    mockListProjects.mockResolvedValueOnce([existingProject]);
    mockSelect.mockResolvedValueOnce('proj_1');
    mockConfirm.mockResolvedValueOnce(true);

    await runLink(root);

    expect(mockConfirm).toHaveBeenCalledWith({
      message:
        'Linking to an existing project. Running `void deploy` will overwrite the current deployment of existing-app.void.app. Continue?',
    });
    expect(JSON.parse(readFileSync(join(root, '.void', 'project.json'), 'utf-8'))).toEqual({
      applicationDomain: 'void.app',
      platform: 'void',
      platformUrl: 'https://api.void.cloud',
      proxyUrl: 'https://proxy.void.cloud',
      projectId: 'proj_1',
      slug: 'existing-app',
    });
    expect(stripVTControlCharacters(String(mockOutro.mock.calls[0]?.[0]))).toBe(
      'Linked to existing-app.void.app',
    );
  });

  it('links through a legacy Void Cloud selection without reconnecting', async () => {
    const { runLink } = await import('../../src/cli/link.ts');
    rmSync(join(root, 'registry'), { force: true, recursive: true });
    mockReadLegacyHostedPlatformSelection.mockReturnValue({
      apiUrl: 'https://api.void.cloud',
      applicationDomain: 'void.app',
      displayName: 'Void Cloud',
      proxyUrl: 'https://proxy.void.cloud',
      source: 'legacy-credential',
    });
    mockGetToken.mockReturnValue('legacy-token');
    mockListProjects.mockResolvedValueOnce([existingProject]);

    await runLink(root, 'existing-app');

    expect(JSON.parse(readFileSync(join(root, '.void', 'project.json'), 'utf-8'))).toEqual({
      applicationDomain: 'void.app',
      platform: 'void',
      platformUrl: 'https://api.void.cloud',
      proxyUrl: 'https://proxy.void.cloud',
      projectId: 'proj_1',
      slug: 'existing-app',
    });
  });

  it('does not write project config when the existing-project guard is declined', async () => {
    const { runLink } = await import('../../src/cli/link.ts');
    mockGetToken.mockReturnValue('token_123');
    mockListProjects.mockResolvedValueOnce([existingProject]);
    mockSelect.mockResolvedValueOnce('proj_1');
    mockConfirm.mockResolvedValueOnce(false);
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit ${code}`);
    }) as never);

    await expect(runLink(root)).rejects.toThrow('exit 0');

    expect(mockCancel).toHaveBeenCalledWith('Project link cancelled.');
    expect(existsSync(join(root, '.void', 'project.json'))).toBe(false);
  });
});
