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

it('points to the Analytics Engine setup when Cloudflare refuses its binding', () => {
  const raw =
    'You need to enable Analytics Engine. Head to the Cloudflare Dashboard to enable: https://dash.cloudflare.com/account/workers/analytics-engine [code: 10089]';
  const hint =
    ' If the Analytics Engine page offers no way to enable it, follow https://void.cloud/guide/platform/installation/prerequisites#if-cloudflare-rejects-analytics-engine, then retry.';
  expect(() =>
    assertCleanPlatformWrangler(
      { status: 1, stdout: '', stderr: raw, errorCode: 10089 },
      'bootstrap void-team-tail',
    ),
  ).toThrow(`platform: Wrangler failed to bootstrap void-team-tail (${raw}).${hint}`);
  expect(() =>
    assertCleanPlatformWrangler(
      {
        status: 1,
        stdout: '',
        stderr: '',
        errors: [{ code: 10089, message: 'You need to enable Analytics Engine.' }],
      },
      'bootstrap void-team-tail',
    ),
  ).toThrow(hint);
  expect(() =>
    assertCleanPlatformWrangler(
      { status: 1, stdout: '', stderr: 'You need to enable Analytics Engine. [10089]' },
      'bootstrap void-team-tail',
    ),
  ).toThrow(hint);
  expect(() =>
    assertCleanPlatformWrangler(
      { status: 1, stdout: '', stderr: 'Authentication error [code: 10000]', errorCode: 10000 },
      'bootstrap void-team-tail',
    ),
  ).toThrow(
    /^platform: Wrangler failed to bootstrap void-team-tail \(Authentication error \[code: 10000\]\)\.$/,
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
