import { describe, expect, it } from 'vite-plus/test';
import { PlatformApiError } from '../../src/cli/client.ts';
import { formatStreamDeployError } from '../../src/cli/deploy-errors.ts';

describe('formatStreamDeployError', () => {
  it('surfaces 409 deploy-in-progress with the server-supplied deployment id', () => {
    const err = new PlatformApiError(
      'Deploy failed',
      409,
      JSON.stringify({ error: 'deploy in progress', deployment: 'dpl_abc' }),
    );

    const formatted = formatStreamDeployError(err, null);

    expect(formatted).toBeInstanceOf(Error);
    expect(formatted.message).toContain('deploy in progress');
    expect(formatted.message).toContain('dpl_abc');
    expect(formatted.message).not.toContain('Connection lost');
  });

  it('prefers the body-provided deployment id over a previously seen one', () => {
    const err = new PlatformApiError(
      'Deploy failed',
      409,
      JSON.stringify({ error: 'deploy in progress', deployment: 'dpl_body' }),
    );

    const formatted = formatStreamDeployError(err, 'dpl_seen');

    expect(formatted.message).toContain('dpl_body');
    expect(formatted.message).not.toContain('dpl_seen');
  });

  it('surfaces opaque 5xx HTML bodies with status + trimmed snippet (no Connection lost)', () => {
    const err = new PlatformApiError('Deploy failed', 502, '<html>bad gateway</html>');

    const formatted = formatStreamDeployError(err, null);

    expect(formatted.message).toContain('HTTP 502');
    expect(formatted.message).toContain('bad gateway');
    expect(formatted.message).not.toContain('Connection lost');
  });

  it('surfaces 401 JSON-error payloads without the Connection lost prefix', () => {
    const err = new PlatformApiError(
      'Deploy failed',
      401,
      JSON.stringify({ error: 'invalid or expired token' }),
    );

    const formatted = formatStreamDeployError(err, null);

    expect(formatted.message).toContain('invalid or expired token');
    expect(formatted.message).not.toContain('Connection lost');
  });

  it('preserves the original message for generic network errors as Connection lost + cause', () => {
    const err = new TypeError('fetch failed');

    const formatted = formatStreamDeployError(err, null);

    expect(formatted.message).toContain('Connection lost during deploy');
    expect(formatted.message).toContain('fetch failed');
  });

  it('explains a headers timeout in plain words and keeps the log line', () => {
    const err = new TypeError('fetch failed', {
      cause: Object.assign(new Error('Headers Timeout Error'), {
        name: 'HeadersTimeoutError',
        code: 'UND_ERR_HEADERS_TIMEOUT',
      }),
    });

    const formatted = formatStreamDeployError(err, null, '/tmp/deploy.jsonl');

    expect(formatted.message).toBe(
      [
        'deploy: The Void platform did not respond within 5 minutes while preparing the deploy.',
        'It may still finish. Check `void project status`, then run `void deploy` again to retry.',
        'If this keeps happening, share the detailed log below.',
        'Detailed log: /tmp/deploy.jsonl',
      ].join('\n'),
    );
  });

  it('omits the log hint for a headers timeout when no log was written', () => {
    const err = new TypeError('fetch failed', {
      cause: Object.assign(new Error('Headers Timeout Error'), {
        code: 'UND_ERR_HEADERS_TIMEOUT',
      }),
    });

    const formatted = formatStreamDeployError(err, null, null);

    expect(formatted.message).not.toContain('log');
    expect(formatted.message).toContain('void project status');
  });

  it('adds the root cause of a fetch failure', () => {
    const err = new TypeError('fetch failed', {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.example.com'), {
        code: 'ENOTFOUND',
      }),
    });

    const formatted = formatStreamDeployError(err, null, '/tmp/deploy.jsonl');

    expect(formatted.message).toBe(
      "deploy: Connection lost during deploy: 'fetch failed' (getaddrinfo ENOTFOUND api.example.com).\n" +
        'Detailed log: /tmp/deploy.jsonl',
    );
  });

  it('uses the cause code when the root cause has no message', () => {
    const refused = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' });
    const closed = Object.assign(new Error('other side closed'), {
      name: 'SocketError',
      code: 'UND_ERR_SOCKET',
    });

    expect(
      formatStreamDeployError(new TypeError('fetch failed', { cause: refused }), null).message,
    ).toBe("deploy: Connection lost during deploy: 'fetch failed' (ECONNREFUSED).");
    expect(
      formatStreamDeployError(new TypeError('fetch failed', { cause: closed }), null).message,
    ).toBe(
      "deploy: Connection lost during deploy: 'fetch failed' (UND_ERR_SOCKET: other side closed).",
    );
  });

  it('includes the deployment id for generic mid-stream errors when known', () => {
    const err = new Error('reader canceled');

    const formatted = formatStreamDeployError(err, 'dpl_x');

    expect(formatted.message).toContain('reader canceled');
    expect(formatted.message).toContain('dpl_x');
  });

  it('bounds the formatted message length for large opaque bodies', () => {
    const bigBody = 'x'.repeat(2048);
    const err = new PlatformApiError('Deploy failed', 500, bigBody);

    const formatted = formatStreamDeployError(err, null);

    expect(formatted.message.length).toBeLessThan(300);
    expect(formatted.message).toContain('HTTP 500');
  });

  it('never replaces a real error message with only "Connection lost during deploy"', () => {
    // Regression guard: prior behavior collapsed any non-DeployEventError to the
    // opaque connection-lost string, hiding the real cause. The new contract must
    // always preserve the original message substring for generic errors.
    const err = new Error('socket hang up');

    const formatted = formatStreamDeployError(err, null);

    expect(formatted.message).toContain('socket hang up');
  });

  it('falls back to the raw body when the JSON payload has no error/message field', () => {
    const err = new PlatformApiError('Deploy failed', 500, JSON.stringify({ foo: 'bar' }));

    const formatted = formatStreamDeployError(err, null);

    expect(formatted.message).toContain('HTTP 500');
    // Body snippet should still be present somewhere since there is no parsed error field.
    expect(formatted.message.length).toBeGreaterThan('Deploy failed (HTTP 500): '.length);
  });
});
