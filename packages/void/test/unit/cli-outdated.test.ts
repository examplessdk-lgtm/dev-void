import { describe, expect, it } from 'vite-plus/test';
import { isCliOutdatedError, PlatformApiError } from '../../src/cli/client.ts';
import { formatStreamDeployError } from '../../src/cli/deploy-errors.ts';

const OUTDATED_BODY = JSON.stringify({
  error: 'cli_outdated',
  message:
    'Your void CLI is too old: it sent a multipart deploy body, which is no longer supported. Upgrade with: npm i -g void@latest (minimum version 0.7.0).',
  minVersion: '0.7.0',
});

describe('PlatformApiError + cli_outdated', () => {
  it('overrides the default message with the server-supplied upgrade text on 426', () => {
    const err = new PlatformApiError('Deploy failed', 426, OUTDATED_BODY);
    expect(err.message).not.toContain('426');
    expect(err.message).not.toContain('{');
    expect(err.message).toContain('npm i -g void@latest');
    expect(err.message).toContain('Upgrade with');
    expect(err.code).toBe('cli_outdated');
    expect(err.status).toBe(426);
  });

  it('keeps the default message when status is 426 but body is not cli_outdated', () => {
    const err = new PlatformApiError('Deploy failed', 426, '{"error":"something_else"}');
    expect(err.message).toContain('Deploy failed');
    expect(err.message).toContain('426');
  });

  it('keeps the default message when body is cli_outdated but status is not 426', () => {
    // Defensive: status is what the gate sets, body shape alone shouldn't trigger
    // the override (avoids letting a misconfigured upstream forge upgrade prompts).
    const err = new PlatformApiError('Deploy failed', 400, OUTDATED_BODY);
    expect(err.message).toContain('400');
  });
});

describe('isCliOutdatedError', () => {
  it('detects 426 + cli_outdated', () => {
    expect(isCliOutdatedError(new PlatformApiError('x', 426, OUTDATED_BODY))).toBe(true);
  });

  it('rejects unrelated PlatformApiErrors', () => {
    expect(isCliOutdatedError(new PlatformApiError('x', 403, 'forbidden'))).toBe(false);
    expect(isCliOutdatedError(new PlatformApiError('x', 426, '{"error":"other"}'))).toBe(false);
    expect(isCliOutdatedError(new Error('plain'))).toBe(false);
    expect(isCliOutdatedError(null)).toBe(false);
  });
});

describe('formatStreamDeployError + cli_outdated', () => {
  it('surfaces the server message verbatim with no HTTP wrapper', () => {
    const err = new PlatformApiError('Deploy failed', 426, OUTDATED_BODY);
    const formatted = formatStreamDeployError(err, null, null);
    expect(formatted.message).not.toContain('Deploy failed (HTTP 426)');
    expect(formatted.message).toContain('npm i -g void@latest');
  });

  it('appends deployment id and log path when supplied', () => {
    const err = new PlatformApiError('Deploy failed', 426, OUTDATED_BODY);
    const formatted = formatStreamDeployError(err, 'dep_abc', '/tmp/log.txt');
    expect(formatted.message).toContain('npm i -g void@latest');
    expect(formatted.message).toContain('Deployment: dep_abc');
    expect(formatted.message).toContain('Detailed log: /tmp/log.txt');
  });
});
