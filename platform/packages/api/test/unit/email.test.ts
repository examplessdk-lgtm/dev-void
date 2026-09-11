import { describe, expect, it } from 'vite-plus/test';
import { sendErrorAlertEmail } from '../../src/email.ts';

type SentMessage = { from: string; to: string; subject: string; html: string; text: string };

function mockBinding() {
  const sent: Array<SentMessage> = [];
  const binding = {
    send: async (msg: SentMessage) => {
      sent.push(msg);
    },
  } as unknown as Parameters<typeof sendErrorAlertEmail>[0];
  return { binding, sent };
}

describe('sendErrorAlertEmail', () => {
  const DASH = 'https://dash.void.cloud';
  const start = Date.parse('2026-07-16T16:30:00Z');
  const end = Date.parse('2026-07-16T17:30:00Z');

  it('stamps the concrete UTC window instead of the word "recently"', async () => {
    const { binding, sent } = mockBinding();
    await sendErrorAlertEmail(binding, 'u@example.com', 'recappi', 1252, DASH, { start, end }, end);
    const msg = sent[0];

    expect(msg.subject).toBe('5xx errors detected: recappi');
    expect(msg.html).toContain('2026-07-16 16:30 UTC');
    expect(msg.html).toContain('2026-07-16 17:30 UTC');
    expect(msg.html).not.toContain('recently');
    expect(msg.text).toContain('2026-07-16 16:30 UTC');
    expect(msg.text).not.toContain('recently');
  });

  it('formats the error count with thousands separators', async () => {
    const { binding, sent } = mockBinding();
    await sendErrorAlertEmail(binding, 'u@example.com', 'recappi', 1252, DASH, { start, end }, end);
    expect(sent[0].html).toContain('1,252');
    expect(sent[0].text).toContain('1,252');
  });

  it('recommends the request-level command first, then logs, both sized to the window', async () => {
    const { binding, sent } = mockBinding();
    // 1h window, sent at the last error => ceil(1)+1 = 2h suggested range.
    await sendErrorAlertEmail(binding, 'u@example.com', 'recappi', 1252, DASH, { start, end }, end);

    // `requests` is the only view that can show edge-generated / static 5xx,
    // which never reach a worker and so never produce log rows.
    expect(sent[0].text).toContain('void project requests --status 5xx --range 2h');
    expect(sent[0].html).toContain('void project requests --status 5xx --range 2h');
    expect(sent[0].text).toContain('void project logs --level error --range 2h');
    expect(sent[0].html).toContain('void project logs --level error --range 2h');
  });

  it('anchors the suggested range at send time, not at the last error', async () => {
    const { binding, sent } = mockBinding();
    // A point burst at 10:00 whose delivery kept failing until 12:01. A range
    // derived from the window alone would be 1h and would exclude the errors.
    const burst = Date.parse('2026-07-23T10:00:00Z');
    const sentAt = Date.parse('2026-07-23T12:01:00Z');
    await sendErrorAlertEmail(
      binding,
      'u@example.com',
      'recappi',
      7,
      DASH,
      { start: burst, end: burst },
      sentAt,
    );

    expect(sent[0].text).toContain('--range 4h');
    expect(sent[0].text).not.toContain('--range 1h');
    // The window itself is still reported honestly.
    expect(sent[0].text).toContain('2026-07-23 10:00 UTC');
  });

  it('caps the suggested range at the CLI 7-day limit for old windows', async () => {
    const { binding, sent } = mockBinding();
    const oldStart = Date.parse('2026-07-01T00:00:00Z');
    const recentEnd = Date.parse('2026-07-16T00:00:00Z'); // 15 days
    await sendErrorAlertEmail(
      binding,
      'u@example.com',
      'recappi',
      40,
      DASH,
      { start: oldStart, end: recentEnd },
      recentEnd,
    );
    expect(sent[0].text).toContain('--range 7d');
  });

  it('falls back to "recently" wording when no window is known', async () => {
    const { binding, sent } = mockBinding();
    await sendErrorAlertEmail(binding, 'u@example.com', 'recappi', 5, DASH, null, Date.now());
    const msg = sent[0];
    expect(msg.html).toContain('recently');
    expect(msg.html).toContain('void project requests --status 5xx --range');
    expect(msg.text).toContain('recently');
  });

  it('links to the dashboard project page', async () => {
    const { binding, sent } = mockBinding();
    await sendErrorAlertEmail(binding, 'u@example.com', 'recappi', 1252, DASH, { start, end }, end);
    expect(sent[0].html).toContain('https://dash.void.cloud/projects/recappi');
  });
});
