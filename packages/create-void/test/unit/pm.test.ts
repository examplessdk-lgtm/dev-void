import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { VOID_PNPM_ALLOWED_BUILDS, writePnpmBuildPolicy } from '../../src/pm.ts';

const temporaryDirectories: Array<string> = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('create-void package manager bootstrap', () => {
  it('writes the narrow Void build policy before a fresh pnpm install', () => {
    const root = mkdtempSync(join(tmpdir(), 'create-void-pnpm-'));
    temporaryDirectories.push(root);

    writePnpmBuildPolicy(root, 'pnpm');

    expect(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf-8')).toBe(
      `allowBuilds:\n  better-sqlite3: false\n${VOID_PNPM_ALLOWED_BUILDS.map((name) => `  ${name}: true`).join('\n')}\n`,
    );
  });

  it('does not add pnpm policy files for other package managers', () => {
    for (const manager of ['npm', 'yarn', 'bun'] as const) {
      const root = mkdtempSync(join(tmpdir(), `create-void-${manager}-`));
      temporaryDirectories.push(root);

      writePnpmBuildPolicy(root, manager);

      expect(existsSync(join(root, 'pnpm-workspace.yaml'))).toBe(false);
    }
  });

  it('stays aligned with the policy written by void init', () => {
    const initSource = readFileSync(
      join(import.meta.dirname, '../../../void/src/cli/init.ts'),
      'utf-8',
    );
    const declaration = initSource.match(
      /const PNPM_ALLOWED_BUILDS = \[([\s\S]*?)\] as const;/,
    )?.[1];
    if (!declaration) {
      throw new Error('Could not find the void init pnpm build policy.');
    }
    const initAllowedBuilds = [...declaration.matchAll(/'([^']+)'/g)].map((match) => match[1]);

    expect(VOID_PNPM_ALLOWED_BUILDS).toEqual(initAllowedBuilds);
  });
});
