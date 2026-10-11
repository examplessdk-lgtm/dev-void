import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { captureOutput } from '../helpers/cli-command.ts';

vi.mock('../../src/cli/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/auth.ts')>()),
  getToken: () => 'test-token',
}));

vi.mock('../../src/cli/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/client.ts')>()),
  PlatformClient: class {
    async listProjects() {
      return [{ id: 'proj_123', slug: 'my-app' }];
    }
    async deleteProject() {
      return {};
    }
  },
}));

const roots: Array<string> = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('void project delete', () => {
  it('reports the deletion once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-root-'));
    roots.push(root);
    const { runDeleteCommand } = await import('../../src/cli/delete.ts');

    const capture = captureOutput();
    try {
      await runDeleteCommand(root, 'my-app', { force: true });
    } finally {
      capture.restore();
    }
    const out = capture.output();

    expect(out).toContain('Deleted my-app');
    expect(out).not.toContain('Project deleted.');
  });
});
