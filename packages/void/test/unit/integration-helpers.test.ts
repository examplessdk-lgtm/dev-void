import { spawnSync } from 'node:child_process';
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  shouldCopyPlaygroundPath,
} from '../../../../test/integration-helpers.ts';

describe('shouldCopyPlaygroundPath', () => {
  it('excludes generated top-level entries from native Windows paths', () => {
    const sourceRoot = String.raw`D:\a\void\void\playground\spa`;

    expect(shouldCopyPlaygroundPath(sourceRoot, String.raw`${sourceRoot}\node_modules`)).toBe(
      false,
    );
    expect(shouldCopyPlaygroundPath(sourceRoot, String.raw`${sourceRoot}\.void`)).toBe(false);
    expect(
      shouldCopyPlaygroundPath(sourceRoot, String.raw`${sourceRoot}\.next\types\routes.d.ts`),
    ).toBe(false);
    expect(shouldCopyPlaygroundPath(sourceRoot, String.raw`${sourceRoot}\src\index.ts`)).toBe(true);
  });

  it('only excludes generated entries at the playground root', () => {
    const sourceRoot = '/workspace/playground/spa';

    expect(shouldCopyPlaygroundPath(sourceRoot, `${sourceRoot}/dist`)).toBe(false);
    expect(shouldCopyPlaygroundPath(sourceRoot, `${sourceRoot}/.next/types/routes.d.ts`)).toBe(
      false,
    );
    expect(shouldCopyPlaygroundPath(sourceRoot, `${sourceRoot}/src/dist/example.ts`)).toBe(true);
    expect(shouldCopyPlaygroundPath(sourceRoot, `${sourceRoot}/src/.next/example.ts`)).toBe(true);
  });
});

it('keeps copied manifests outside the actual workspace package glob during cleanup', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'void-isolated-playground-'));
  const source = join(workspace, 'playground', 'app');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'original-app' }));
  writeFileSync(join(source, 'entry.ts'), 'export const marker = "original";');
  const patterns = readFileSync(new URL('../../../../pnpm-workspace.yaml', import.meta.url), 'utf8')
    .split('\n')
    .flatMap((line) => line.match(/^ {2}- (playground-local\/\S+)$/)?.[1] ?? []);
  expect(patterns).toEqual(['playground-local/*']);
  const first = createIsolatedPlayground(workspace, 'playground/app');
  const second = createIsolatedPlayground(workspace, 'playground/app');
  try {
    const manifests = () =>
      patterns.flatMap((pattern) => globSync(`${pattern}/package.json`, { cwd: workspace }));
    expect(manifests()).toEqual([]);
    expect(readFileSync(join(first.root, 'entry.ts'), 'utf8')).toContain('original');
    expect(JSON.parse(readFileSync(join(first.root, 'package.json'), 'utf8')).name).not.toBe(
      JSON.parse(readFileSync(join(second.root, 'package.json'), 'utf8')).name,
    );
    first.cleanup();
    expect(manifests()).toEqual([]);
    expect(existsSync(join(second.root, 'package.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).name).toBe(
      'original-app',
    );
  } finally {
    first.cleanup();
    second.cleanup();
    rmSync(workspace, { recursive: true, force: true });
  }
});

it('clears the shutdown deadline after a real child exits', () => {
  const helper = new URL('../../../../test/integration-helpers.ts', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { spawn } from 'node:child_process';
    import { killChild } from ${JSON.stringify(helper)};
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore' });
    try {
      await killChild(child);
      console.log(JSON.stringify(process.getActiveResourcesInfo().filter(type => type === 'Timeout')));
    } finally {
      child.kill('SIGKILL');
    }
    process.exit(0);
  `,
    ],
    { encoding: 'utf8', timeout: 15_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('[]');
}, 20_000);
