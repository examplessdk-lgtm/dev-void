import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vite-plus/test';
import { shouldCopyPlaygroundPath } from '../../../../test/integration-helpers.ts';

describe('shouldCopyPlaygroundPath', () => {
  it('excludes generated top-level entries from native Windows paths', () => {
    const sourceRoot = String.raw`D:\a\void\void\playground\spa`;

    expect(shouldCopyPlaygroundPath(sourceRoot, String.raw`${sourceRoot}\node_modules`)).toBe(
      false,
    );
    expect(shouldCopyPlaygroundPath(sourceRoot, String.raw`${sourceRoot}\.void`)).toBe(false);
    expect(shouldCopyPlaygroundPath(sourceRoot, String.raw`${sourceRoot}\src\index.ts`)).toBe(true);
  });

  it('only excludes generated entries at the playground root', () => {
    const sourceRoot = '/workspace/playground/spa';

    expect(shouldCopyPlaygroundPath(sourceRoot, `${sourceRoot}/dist`)).toBe(false);
    expect(shouldCopyPlaygroundPath(sourceRoot, `${sourceRoot}/src/dist/example.ts`)).toBe(true);
  });
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
