import { log, note } from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { EmailLogsResponse, PlatformClient } from '../../src/cli/client.ts';
import { emailLogs } from '../../src/cli/email.ts';

function client(body: EmailLogsResponse): Pick<PlatformClient, 'getEmailLogs'> {
  return { getEmailLogs: vi.fn(async () => body) };
}

vi.mock('@clack/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clack/prompts')>();
  return { ...actual, note: vi.fn() };
});

beforeEach(() => {
  vi.spyOn(log, 'info').mockImplementation(() => {});
  vi.mocked(note).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('void email logs', () => {
  it('reports an empty project ledger', async () => {
    const api = client({ logs: [] });
    await emailLogs(api, 'prj_1', 25);
    expect(api.getEmailLogs).toHaveBeenCalledWith('prj_1', 25);
    expect(log.info).toHaveBeenCalledWith('No email activity recorded.');
  });

  it('renders sent and received ledger entries with recipient outcomes', async () => {
    const api = client({
      logs: [
        {
          timestamp: Date.parse('2026-09-19T00:00:00Z'),
          direction: 'sent',
          operationId: 'eact_1',
          receiptId: null,
          recipient: 'owner@example.com',
          status: 'provider_accepted',
          transport: 'send_raw',
          providerReference: 'cf_1',
          errorCode: null,
          policyVersion: 1,
        },
        {
          timestamp: Date.parse('2026-09-18T23:00:00Z'),
          direction: 'received',
          operationId: 'ercpt_1',
          receiptId: 'ercpt_1',
          recipient: null,
          status: 'actions_rejected',
          transport: 'email_event',
          providerReference: null,
          errorCode: 'INVALID_ACTIONS',
          policyVersion: null,
        },
      ],
    });
    await emailLogs(api, 'prj_1');
    const rendered = vi.mocked(note).mock.calls[0]?.[0];
    expect(rendered).toContain(
      '2026-09-19T00:00:00.000Z  →  eact_1  owner@example.com  provider_accepted',
    );
    expect(rendered).toContain(
      '2026-09-18T23:00:00.000Z  ←  ercpt_1  —  actions_rejected (INVALID_ACTIONS)',
    );
  });
});
