import { log } from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { PlatformClient } from '../../src/cli/client.ts';
import { emailDisallow } from '../../src/cli/email.ts';

/**
 * What `void email disallow <address>` prints on success. The one contract
 * under test: the line must not tell the user a deploy is needed. The api
 * tightens the proxy's `email-allowlist:<projectId>` KV mirror inside the
 * DELETE (503 if that write fails) and the proxy re-reads the mirror with a
 * 60s `cacheTtl` on both the send path and inbound forward/reply, so the
 * revocation lands on its own within about a minute — no deploy touches
 * the allowlist.
 */

type Destination = Awaited<ReturnType<PlatformClient['listEmailDestinations']>>[number];

const ADDRESS = 'owner@example.com';

function destination(overrides: Partial<Destination> = {}): Destination {
  return {
    id: 'edst_1',
    address: ADDRESS,
    status: 'verified',
    verified_at: '2026-09-01T00:00:00Z',
    created_at: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

function client(
  rows: Array<Destination>,
): Pick<PlatformClient, 'listEmailDestinations' | 'removeEmailDestination'> {
  return {
    listEmailDestinations: vi.fn(async () => rows),
    removeEmailDestination: vi.fn(async () => ({ ok: true })),
  };
}

type LogSpy = ReturnType<typeof vi.spyOn>;

let successSpy: LogSpy;

beforeEach(() => {
  successSpy = vi.spyOn(log, 'success').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function printed(spy: LogSpy): string {
  return (spy.mock.calls as Array<Array<unknown>>).map((call) => String(call[0])).join('\n');
}

describe('void email disallow', () => {
  it('removes the matching destination and reports the revocation without a deploy', async () => {
    const c = client([destination()]);

    await emailDisallow(c, 'prj_1', ADDRESS);

    expect(c.removeEmailDestination).toHaveBeenCalledWith('prj_1', 'edst_1');
    const text = printed(successSpy);
    expect(text).toBe(`Removed ${ADDRESS}. Sends to it are refused within about a minute.`);
    // The api tightens the KV allowlist in the DELETE and the proxy's
    // cacheTtl bounds convergence; nothing about a revoke waits for a deploy.
    expect(text).not.toMatch(/deploy/);
  });

  it('matches the address case-insensitively and echoes the stored spelling', async () => {
    const c = client([destination({ address: 'Owner@Example.com' })]);

    await emailDisallow(c, 'prj_1', ADDRESS);

    expect(c.removeEmailDestination).toHaveBeenCalledWith('prj_1', 'edst_1');
    expect(printed(successSpy)).toContain('Removed Owner@Example.com.');
  });
});
