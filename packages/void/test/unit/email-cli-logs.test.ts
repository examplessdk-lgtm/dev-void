import { log } from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { EmailLogsResponse, PlatformClient } from '../../src/cli/client.ts';
import { emailLogs } from '../../src/cli/email.ts';

/**
 * What `void email logs` prints while the api still answers
 * `{ logs: [], pending: true }`. The one contract under test: the command
 * never points a hosted-project user at Wrangler. The proxy's send/receive
 * records are the PLATFORM worker's console output, which a project's own
 * Cloudflare credentials cannot tail — so the only truthful pointer is the
 * user's own worker log (`void project logs`), where the email handler's
 * console output lands like any other invocation.
 */

function client(body: EmailLogsResponse): Pick<PlatformClient, 'getEmailLogs'> {
  return { getEmailLogs: vi.fn(async () => body) };
}

type LogSpy = ReturnType<typeof vi.spyOn>;

let infoSpy: LogSpy;

beforeEach(() => {
  infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function printed(spy: LogSpy): string {
  return (spy.mock.calls as Array<Array<unknown>>).map((call) => String(call[0])).join('\n');
}

describe('void email logs', () => {
  it('prints the api note and points at `void project logs` while storage is pending', async () => {
    const note = 'Persistent log storage lands when Analytics Engine queries are wired.';
    const c = client({ logs: [], pending: true, note });

    await emailLogs(c, 'prj_1', 25);

    expect(c.getEmailLogs).toHaveBeenCalledWith('prj_1', 25);
    const text = printed(infoSpy);
    expect(text).toContain(note);
    expect(text).toContain('Email activity logs are not available yet.');
    expect(text).toContain('`void project logs`');
  });

  it('never sends a hosted-project user to Wrangler', async () => {
    // The proxy is Void's worker: `wrangler tail` under the user's own
    // credentials cannot reach it, and the CLI policy forbids the pointer.
    await emailLogs(client({ logs: [], pending: true }), 'prj_1');

    const text = printed(infoSpy);
    expect(text).not.toMatch(/wrangler/i);
    expect(text).not.toContain('proxy worker');
  });

  it('falls back to a generic pending line when the api sends no note', async () => {
    await emailLogs(client({ logs: [], pending: true }), 'prj_1');

    expect(printed(infoSpy)).toContain('Persistent log storage is not yet wired up.');
  });
});
