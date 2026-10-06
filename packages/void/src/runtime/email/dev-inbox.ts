/**
 * In-memory capture sink for emails during local dev / tests.
 *
 * Two consumers:
 *   1. The Vite dev-server middleware (`/__void/inbox`) — owns the buffer that
 *      backs the browsable inbox during `void dev`.
 *   2. The test harness (`void/email/testing`) — registers a sink so
 *      assertions like `expect(harness.messages).toHaveLength(1)` work without
 *      mocking the SEND_EMAIL binding.
 *
 * The sink registry lives on globalThis, but it is only ever an IN-ISOLATE
 * channel. It is NOT a bridge between the dev server and user code: under
 * `void dev` the Vite plugin runs in Node while user code runs in workerd — a
 * separate OS process started by miniflare — so each has its own globalThis and
 * its own (empty) registry. A `sendEmail` call inside the worker therefore
 * never sees the plugin's sink.
 *
 * The cross-process hop is explicit instead: the worker POSTs the captured
 * message to {@link DEV_INBOX_CAPTURE_URL} through its dev assets binding
 * (which `@cloudflare/vite-plugin` wires straight into the Vite dev server's
 * Node middleware stack), and the plugin's middleware pushes it into the
 * buffer. See `runtime/email.ts` and `plugin-email-dev-inbox.ts`.
 */

import { MAX_MESSAGE_BYTES } from './mime.ts';
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

// ---------------------------------------------------------------------------
// Cross-process capture protocol (workerd -> Vite dev server)
// ---------------------------------------------------------------------------

/** Mount point of the dev inbox on the Vite dev server. */
export const DEV_INBOX_PREFIX: string = '/__void/inbox';
/** Capture endpoint, relative to {@link DEV_INBOX_PREFIX} (connect strips the mount). */
export const DEV_INBOX_CAPTURE_PATH: string = '/_capture';
/** Absolute path the worker POSTs a captured message to. */
export const DEV_INBOX_CAPTURE_URL: string = `${DEV_INBOX_PREFIX}${DEV_INBOX_CAPTURE_PATH}`;

/**
 * Serve-only var naming the fetcher binding that loops back to the Vite dev
 * server. Its presence is also the dev gate: `sendEmail` only attempts the dev
 * inbox when this var is set, and it is injected exclusively when
 * `viteCommand === 'serve'` (see `shouldInjectEmailDevInboxVar` in index.ts),
 * so a production build never carries it.
 */
export const DEV_INBOX_ENV_VAR: string = '__VOID_EMAIL_DEV_INBOX';

/**
 * Serve-only var carrying the project's dev-trigger token — the same
 * per-project secret `/__void/scheduled` and `/__void/queue` require — so the
 * worker can authenticate its capture POST. Injected together with
 * {@link DEV_INBOX_ENV_VAR} under the same gate. The compiled router embeds
 * the token as a module-local const the `void/email` runtime cannot import,
 * so a var is the only transport into `sendEmail`.
 */
export const DEV_INBOX_TOKEN_ENV_VAR: string = '__VOID_EMAIL_DEV_INBOX_TOKEN';

/**
 * How a caller proves it holds the dev-trigger token. Every `/__void/inbox`
 * route — browse, raw download, clear, and the worker's capture POST —
 * requires one of these, mirroring the `x-void-dev-trigger` check on the
 * cron/queue dev routes. The query form exists for the browser: a link
 * printed in the terminal cannot carry a header, and the inbox pages render
 * their own links with it. Responses send `Referrer-Policy: no-referrer`, so
 * the token never leaves the inbox through a Referer.
 */
export const DEV_INBOX_TOKEN_HEADER: string = 'x-void-dev-trigger';
export const DEV_INBOX_TOKEN_QUERY: string = 'token';

/**
 * Acknowledgement marker on the capture response. The transport rides the
 * assets binding, so a 200 alone proves nothing — if that binding ever stops
 * being a dev-server loopback, a plain static/SPA response would also be 200.
 * The worker treats a capture as delivered only when this header comes back.
 */
export const DEV_INBOX_ACK_HEADER: string = 'x-void-email-inbox';
export const DEV_INBOX_ACK_VALUE: string = 'captured';

/**
 * Upper bound on a capture body. Dev-only, but an unbounded read is still a
 * footgun.
 *
 * Derived from `MAX_MESSAGE_BYTES`, not chosen: a message `buildMime` accepts
 * must never be refused here, or `void dev` fails a send that production
 * delivers. `serializeCapturedMessage` carries the raw MIME as base64 (4/3 of
 * its octets) AND every caller string a second time as JSON, where the
 * expansion over the MIME rendering of the same string is at most 3.75x. That
 * worst case is a control character in a value `encodeWord` renders — the
 * subject, a display name, a custom header value: JSON writes it as `\u0001`
 * (6 bytes) while the encoded-word spends at least 1.6 octets per UTF-8 byte
 * (4/3 of base64 plus 12 octets of `=?UTF-8?B?…?=` per 45-byte word). A body
 * expands at most 2x: the same control is `=01` (3) in quoted-printable, a
 * CRLF (2) is `\r\n` (4), and a `"`, `\` or HTAB (1) is 2. An attachment's
 * filename, media type and Content-ID refuse controls (`rejectControls`), so
 * their worst is `"` or `\` at 2x (verbatim in the media type and Content-ID;
 * escaped, and twice, in the quoted filename), as is a custom header NAME,
 * which is printable ASCII. The MIME holds at most
 * `MAX_MESSAGE_BYTES` of those strings, so the JSON is under
 * `(4/3 + 3.75) * MAX_MESSAGE_BYTES` (5.09x) plus what has no MIME footprint of
 * its own — the JSON framing, ids, timestamps, and the `bcc` addresses
 * (`MAX_RECIPIENTS * MAX_ADDRESS_LENGTH`, 32 KB). 6x is the smallest integer
 * multiple that covers it.
 *
 * Three caller strings have NO MIME footprint, so no multiple of
 * `MAX_MESSAGE_BYTES` bounds them: a `bcc` display name (never rendered), a
 * custom header whose name is reserved (dropped), and a whitespace run inside
 * a long foldable header value (collapsed by folding). They are captured as
 * given, and a message that pads one of them past this cap is still refused.
 */
export const DEV_INBOX_MAX_CAPTURE_BYTES: number = 6 * MAX_MESSAGE_BYTES;

export function bytesToBase64(bytes: Uint8Array): string {
  // 8KB chunks keep us well under the typical V8 fromCharCode arg limit.
  const CHUNK = 0x2000;
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.byteLength)));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array | undefined {
  try {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    return undefined;
  }
}

/** Encode a captured message for the worker -> dev-server hop (`raw` as base64). */
export function serializeCapturedMessage(message: CapturedMessage): string {
  return JSON.stringify({ ...message, raw: bytesToBase64(message.raw) });
}

function asAddress(value: unknown): { email: string; name?: string } | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const v = value as { email?: unknown; name?: unknown };
  if (typeof v.email !== 'string') {
    return undefined;
  }
  return typeof v.name === 'string' ? { email: v.email, name: v.name } : { email: v.email };
}

function asAddressList(value: unknown): Array<{ email: string; name?: string }> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: Array<{ email: string; name?: string }> = [];
  for (const entry of value) {
    const address = asAddress(entry);
    if (!address) {
      return undefined;
    }
    out.push(address);
  }
  return out;
}

/**
 * Decode a capture payload. Returns `undefined` for anything malformed — the
 * endpoint is reachable from the dev server's own origin, so it must reject
 * junk rather than throw inside the middleware.
 */
export function parseCapturedMessage(value: unknown): CapturedMessage | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || typeof v.raw !== 'string') {
    return undefined;
  }
  const raw = base64ToBytes(v.raw);
  const from = asAddress(v.from);
  const to = asAddressList(v.to);
  const cc = asAddressList(v.cc);
  const bcc = asAddressList(v.bcc);
  if (!raw || !from || !to || !cc || !bcc) {
    return undefined;
  }
  const attachments: CapturedMessage['attachments'] = [];
  if (!Array.isArray(v.attachments)) {
    return undefined;
  }
  for (const entry of v.attachments) {
    if (typeof entry !== 'object' || entry === null) {
      return undefined;
    }
    const a = entry as Record<string, unknown>;
    attachments.push({
      filename: typeof a.filename === 'string' ? a.filename : '',
      contentType: typeof a.contentType === 'string' ? a.contentType : 'application/octet-stream',
      size: typeof a.size === 'number' ? a.size : 0,
      ...(typeof a.contentId === 'string' && { contentId: a.contentId }),
      disposition: a.disposition === 'inline' ? 'inline' : 'attachment',
    });
  }
  const headers: Record<string, string> = {};
  if (typeof v.headers === 'object' && v.headers !== null) {
    for (const [k, hv] of Object.entries(v.headers as Record<string, unknown>)) {
      if (typeof hv === 'string') {
        headers[k] = hv;
      }
    }
  }
  const replyTo = asAddress(v.replyTo);
  return {
    id: v.id,
    capturedAt: typeof v.capturedAt === 'number' ? v.capturedAt : Date.now(),
    raw,
    messageId: typeof v.messageId === 'string' ? v.messageId : '',
    from,
    to,
    cc,
    bcc,
    ...(replyTo && { replyTo }),
    subject: typeof v.subject === 'string' ? v.subject : '',
    ...(typeof v.text === 'string' && { text: v.text }),
    ...(typeof v.html === 'string' && { html: v.html }),
    headers,
    attachments,
  };
}

const SINK_KEY = '__voidEmailSinks__';
const BUFFER_KEY = '__voidEmailDevBuffer__';
const DEFAULT_BUFFER_LIMIT = 100;

/**
 * Retained-byte budget for the buffer, alongside the count cap.
 *
 * A count cap alone does not bound the buffer: every item holds its full raw
 * MIME plus the decoded `text`/`html`, and a single message may reach
 * `MAX_MESSAGE_BYTES` (5 MiB), so 100 html-heavy messages is on the order of
 * gigabytes. This buffer lives in the Vite dev server's Node process — not in
 * workerd — so that is the dev server's own heap.
 */
const DEFAULT_BUFFER_BYTES = 64 * 1024 * 1024;

interface DevBuffer {
  /** Running total of {@link messageBytes} over `items`. */
  bytes: number;
  items: Array<CapturedMessage>;
}

interface SinkRegistry {
  sinks: Set<EmailSink>;
}

// Shared across module instances in the dev server's isolate.
const inboxGlobal = globalThis as typeof globalThis & {
  [SINK_KEY]?: SinkRegistry;
  [BUFFER_KEY]?: DevBuffer;
};

function registry(): SinkRegistry {
  let r = inboxGlobal[SINK_KEY];
  if (!r) {
    r = { sinks: new Set() };
    inboxGlobal[SINK_KEY] = r;
  }
  return r;
}

export function registerEmailSink(sink: EmailSink): () => void {
  const r = registry();
  r.sinks.add(sink);
  return () => r.sinks.delete(sink);
}

export function dispatchToSinks(message: CapturedMessage): void {
  for (const sink of registry().sinks) {
    try {
      sink(message);
    } catch (err) {
      // Sinks are best-effort observers — never let one break send, but
      // surface the error so a misbehaving sink is noticed.
      console.warn('[email-dev-inbox] sink error:', err);
    }
  }
}

export function hasActiveSink(): boolean {
  return registry().sinks.size > 0;
}

/** Get or create the shared dev-server ring buffer. */
function getDevBuffer(): DevBuffer {
  let b = inboxGlobal[BUFFER_KEY];
  if (!b) {
    b = { bytes: 0, items: [] };
    inboxGlobal[BUFFER_KEY] = b;
  }
  return b;
}

/** What a retained message costs: the raw MIME plus both decoded bodies. */
function messageBytes(message: CapturedMessage): number {
  return message.raw.byteLength + (message.text?.length ?? 0) + (message.html?.length ?? 0);
}

export function pushToDevBuffer(message: CapturedMessage): void {
  const b = getDevBuffer();
  b.items.push(message);
  b.bytes += messageBytes(message);
  // Oldest-first on either bound. The `items.length > 1` guard keeps the
  // newest message even when it alone blows the budget: a send the developer
  // just made must always be visible in the inbox.
  while (
    b.items.length > DEFAULT_BUFFER_LIMIT ||
    (b.bytes > DEFAULT_BUFFER_BYTES && b.items.length > 1)
  ) {
    const evicted = b.items.shift();
    if (evicted) {
      b.bytes -= messageBytes(evicted);
    }
  }
}

export function listDevMessages(): Array<CapturedMessage> {
  return [...getDevBuffer().items].reverse();
}

export function findDevMessage(id: string): CapturedMessage | undefined {
  return getDevBuffer().items.find((m) => m.id === id);
}

export function clearDevBuffer(): void {
  const b = getDevBuffer();
  b.items.length = 0;
  // Without this the counter goes stale and the buffer silently collapses to a
  // single item on every later push.
  b.bytes = 0;
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
