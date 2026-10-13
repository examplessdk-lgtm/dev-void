import { expect, it } from 'vite-plus/test';
import { assertCleanPlatformWrangler } from '../../src/cli/platform-installer-errors.ts';

it('reports the cf upload conflict from stdout without binding values or completion output', () => {
  const diagnostic =
    'Aborting the upload operation because of conflicts. To override and upload anyway, remove the `--strict` flag';
  const result = {
    status: 1,
    stderr: '',
    stdout: [
      'env.PRIVATE_VALUE: "do-not-echo"',
      '├  Upload',
      '▲  You are about to upload a Worker that was last updated via the script API.',
      '│  Edits that have been made via the script API will be overridden by your local code and config.',
      `■  ${diagnostic}`,
      '│',
      '◆  Version upload complete',
      '',
    ].join('\n'),
  };

  expect(() => assertCleanPlatformWrangler(result, 'upload test-worker')).toThrow(
    'platform: Wrangler failed to upload test-worker (' +
      'You are about to upload a Worker that was last updated via the script API.\n' +
      `${diagnostic}).`,
  );
});

it('reports structured provider errors when stderr is empty using existing credential redaction', () => {
  expect(() =>
    assertCleanPlatformWrangler(
      {
        status: 1,
        stdout: 'env.PRIVATE_VALUE: "do-not-echo"',
        stderr: '',
        errors: [{ code: 10000, message: 'Invalid Authorization: Bearer synthetic-token' }],
      },
      'upload test-worker',
    ),
  ).toThrow(
    'platform: Wrangler failed to upload test-worker (Invalid Authorization: Bearer [redacted]).',
  );
});

it('retains the exit status when stdout contains only binding values', () => {
  expect(() =>
    assertCleanPlatformWrangler(
      { status: 1, stdout: 'env.PRIVATE_VALUE: "do-not-echo"', stderr: '' },
      'upload test-worker',
    ),
  ).toThrow('platform: Wrangler failed to upload test-worker (exit 1).');
});
