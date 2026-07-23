import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import { join } from 'pathslash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mockCancel = vi.fn();
const mockConfirm = vi.fn();
const mockGetToken = vi.fn();
const mockListProjects = vi.fn();
const mockOutro = vi.fn();
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
    listProjects(...args: Array<unknown>) {
      return mockListProjects(...args);
    }
  },
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
    mockCancel.mockReset();
    mockConfirm.mockReset();
    mockGetToken.mockReset();
    mockListProjects.mockReset();
    mockOutro.mockReset();
    mockSelect.mockReset();
  });

  afterEach(() => {
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
      projectId: 'proj_1',
      slug: 'existing-app',
    });
    expect(stripVTControlCharacters(String(mockOutro.mock.calls[0]?.[0]))).toBe(
      'Linked to existing-app.void.app',
    );
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
