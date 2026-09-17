import { describe, expect, it } from 'vite-plus/test';
import { cloudflareCommandDiagnostic } from '../../src/diagnostics.ts';

describe('Cloudflare command diagnostics', () => {
  it('extracts a multiline error and strips terminal formatting and log banners', () => {
    expect(
      cloudflareCommandDiagnostic({
        status: 1,
        stdout: 'env.PRIVATE_VALUE: "do-not-echo"',
        stderr:
          '\u001b[33m▲ [WARNING] A warning\u001b[0m\n' +
          '\u001b[31m✘ [ERROR]\u001b[0m A request to the Cloudflare API failed.\r\n\r\n' +
          '  Compatibility flag specified multiple times: nodejs_als [code: 10021]\r\n' +
          '\n🪵 Logs were written to "debug.log"',
      }),
    ).toBe(
      'A request to the Cloudflare API failed.\n\n  Compatibility flag specified multiple times: nodejs_als [code: 10021]',
    );
  });

  it('uses a marked stdout error without echoing preceding binding values', () => {
    expect(
      cloudflareCommandDiagnostic({
        status: 1,
        stdout: 'env.PRIVATE_VALUE: "do-not-echo"\n✘ [ERROR] Upload failed.',
        stderr: '',
      }),
    ).toBe('Upload failed.');
    expect(
      cloudflareCommandDiagnostic({
        status: 1,
        stdout: 'env.PRIVATE_VALUE: "do-not-echo"',
        stderr: '',
      }),
    ).toBeUndefined();
    expect(
      cloudflareCommandDiagnostic({
        status: 1,
        stdout: 'env.PRIVATE_VALUE: "contains [ERROR] do-not-echo"',
        stderr: '',
      }),
    ).toBeUndefined();
  });

  it('retains plain stderr and process-spawn failures', () => {
    expect(
      cloudflareCommandDiagnostic({ status: 1, stdout: '', stderr: 'Unknown argument: strict' }),
    ).toBe('Unknown argument: strict');
    expect(
      cloudflareCommandDiagnostic({ status: 1, stdout: '', stderr: '', error: 'spawn ENOENT' }),
    ).toBe('spawn ENOENT');
  });

  it('redacts credentials before returning the diagnostic', () => {
    const diagnostic = cloudflareCommandDiagnostic({
      status: 1,
      stdout: '',
      stderr: [
        '✘ [ERROR] Authorization: Bearer bearer-value',
        'Authorization: Basic basic-value',
        'https://example.com/?X-Amz-Signature=signed-value&token=query-value',
        'postgres://user:password-value@example.com/db',
        'CLOUDFLARE_API_TOKEN="api-value"',
        'CF_ACCESS_CLIENT_SECRET=access-value',
      ].join('\n'),
    });
    for (const value of [
      'bearer-value',
      'basic-value',
      'signed-value',
      'query-value',
      'password-value',
      'api-value',
      'access-value',
    ]) {
      expect(diagnostic).not.toContain(value);
    }
    expect(diagnostic).toContain('Authorization: Bearer [redacted]');
    expect(diagnostic).toContain('postgres://[redacted]@example.com/db');
  });

  it('bounds large errors and long stack traces', () => {
    const diagnostic = (stderr: string) =>
      cloudflareCommandDiagnostic({ status: 1, stdout: '', stderr })!;
    expect(diagnostic('✘ [ERROR] ' + 'x'.repeat(10_000)).length).toBeLessThan(4200);
    expect(diagnostic('✘ [ERROR] ' + 'at index.js:42:1\n'.repeat(100)).split('\n')).toHaveLength(
      25,
    );
    expect(diagnostic('✘ [ERROR] ' + 'x'.repeat(10_000))).toContain('[diagnostic truncated]');
  });
});
