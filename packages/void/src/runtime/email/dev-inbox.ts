/**
 * In-memory capture sink for emails during local dev / tests.
 *
 * Two consumers:
 *   1. The Vite dev-server middleware (`/__void/inbox`) — registers a sink at
 *      plugin start so `sendEmail` calls during `void dev` go to a buffer
 *      browsable in the dashboard route handlers.
 *   2. The test harness (`void/email/testing`) — registers a sink so
 *      assertions like `expect(harness.messages).toHaveLength(1)` work without
 *      mocking the SEND_EMAIL binding.
 *
 * Sinks live on globalThis so they survive bundling boundaries (the Vite
 * dev-server plugin runs in Node; user code runs in workerd; both share the
 * same JS runtime in `vite dev`'s in-process worker mode).
 */

import type { NormalizedEmail, NormalizedAttachment } from './types.ts';

export interface CapturedMessage {
  id: string;
  capturedAt: number;
  raw: Uint8Array;
  messageId: string;
  from: { email: string; name?: string };
  to: Array<{ email: string; name?: string }>;
  cc: Array<{ email: string; name?: string }>;
  bcc: Array<{ email: string; name?: string }>;
  replyTo?: { email: string; name?: string };
  subject: string;
  text?: string;
  html?: string;
  headers: Record<string, string>;
  attachments: Array<{
    filename: string;
    contentType: string;
    size: number;
    contentId?: string;
    disposition: 'attachment' | 'inline';
  }>;
}

export type EmailSink = (message: CapturedMessage) => void;

const SINK_KEY = '__voidEmailSinks__';
const BUFFER_KEY = '__voidEmailDevBuffer__';
const DEFAULT_BUFFER_LIMIT = 100;

interface DevBuffer {
  limit: number;
  items: Array<CapturedMessage>;
}

interface SinkRegistry {
  sinks: Set<EmailSink>;
}

function registry(): SinkRegistry {
  const g = globalThis as unknown as Record<string, SinkRegistry | undefined>;
  let r = g[SINK_KEY];
  if (!r) {
    r = { sinks: new Set() };
    g[SINK_KEY] = r;
  }
  return r;
}

export function registerEmailSink(sink: EmailSink): () => void {
  const r = registry();
  r.sinks.add(sink);
  return () => r.sinks.delete(sink);
}

export function dispatchToSinks(message: CapturedMessage): boolean {
  const r = registry();
  if (r.sinks.size === 0) {
    return false;
  }
  for (const sink of r.sinks) {
    try {
      sink(message);
    } catch (err) {
      // Sinks are best-effort observers — never let one break send.
      // Surface the error so test/dev-server authors notice misbehaving
      // sinks (silent swallow hid genuine bugs in test-harness setup).
      console.warn('[email-dev-inbox] sink error:', err);
    }
  }
  return true;
}

export function hasActiveSink(): boolean {
  return registry().sinks.size > 0;
}

/** Get or create the shared dev-server ring buffer. */
export function getDevBuffer(limit: number = DEFAULT_BUFFER_LIMIT): DevBuffer {
  const g = globalThis as unknown as Record<string, DevBuffer | undefined>;
  let b = g[BUFFER_KEY];
  if (!b) {
    b = { limit, items: [] };
    g[BUFFER_KEY] = b;
  }
  return b;
}

export function pushToDevBuffer(message: CapturedMessage): void {
  const b = getDevBuffer();
  b.items.push(message);
  while (b.items.length > b.limit) {
    b.items.shift();
  }
}

export function listDevMessages(): Array<CapturedMessage> {
  return [...getDevBuffer().items].reverse();
}

export function findDevMessage(id: string): CapturedMessage | undefined {
  return getDevBuffer().items.find((m) => m.id === id);
}

export function clearDevBuffer(): void {
  getDevBuffer().items.length = 0;
}

export function captureMessage(
  email: NormalizedEmail,
  raw: Uint8Array,
  messageId: string,
): CapturedMessage {
  return {
    id: generateCaptureId(),
    capturedAt: Date.now(),
    raw,
    messageId,
    from: email.from,
    to: email.to,
    cc: email.cc,
    bcc: email.bcc,
    replyTo: email.replyTo,
    subject: email.subject,
    text: email.text,
    html: email.html,
    headers: { ...email.headers },
    attachments: email.attachments.map((a: NormalizedAttachment) => ({
      filename: a.filename,
      contentType: a.contentType,
      size: a.bytes.byteLength,
      contentId: a.contentId,
      disposition: a.disposition,
    })),
  };
}

function generateCaptureId(): string {
  // Compact ULID-like id: timestamp + 8 random bytes hex.
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return `dev_${Date.now().toString(36)}${hex}`;
}
