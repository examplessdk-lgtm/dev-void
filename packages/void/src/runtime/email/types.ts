/**
 * Public types for the void/email module.
 *
 * The runtime entrypoint (../email.ts) re-exports these so that consumers
 * can import them via `import type { SendEmailOptions } from "void/email"`.
 */

export type Address = string | { email: string; name?: string };

export interface Attachment {
  filename: string;
  content: string | Uint8Array | ArrayBuffer | Blob;
  contentType?: string;
  contentId?: string;
  disposition?: 'attachment' | 'inline';
}

export interface SendEmailOptions {
  /**
   * Sender envelope address. Optional — when omitted, the framework
   * substitutes `<__VOID_PROJECT_SLUG>+noreply@<__VOID_EMAIL_DOMAIN>`
   * from the two platform-injected bindings (the project slug and the
   * mail domain configured for this environment). Outside a deployed
   * worker, or whenever either binding is missing, `sendEmail` returns
   * `INVALID_FROM` — it never falls back to a baked-in domain.
   */
  from?: Address;
  to: Address | Array<Address>;
  subject: string;
  text?: string;
  html?: string;
  replyTo?: Address;
  cc?: Address | Array<Address>;
  bcc?: Address | Array<Address>;
  headers?: Record<string, string>;
  attachments?: Array<Attachment>;
  /**
   * Per-call escape hatch for local development. When true, bypasses the
   * `void dev` in-memory inbox and sends through the proxy as if running
   * in production. Useful for one-off "test the real send pipeline"
   * checks without restarting the dev server.
   *
   * Has no effect outside `void dev` (production always sends; the dev
   * inbox is registered only when `void dev` is running).
   */
  sendInDev?: boolean;
}

export type SendEmailErrorCode =
  | 'BINDING_MISSING'
  | 'INVALID_FROM'
  | 'INVALID_TO'
  | 'UNVERIFIED_DESTINATION'
  | 'MIME_ERROR'
  | 'QUOTA_EXCEEDED'
  | 'UPSTREAM_ERROR';

export interface SendEmailError {
  code: SendEmailErrorCode;
  message: string;
  cause?: unknown;
}

/**
 * One successful CF envelope send. The `to`/`cc`/`bcc` fan-out produces one
 * of these per recipient, since the CF `EmailMessage` envelope is
 * single-recipient.
 */
export interface SendEmailDelivery {
  recipient: string;
  messageId: string;
}

/**
 * Per-recipient outcome for a multi-recipient send. `ok: true` carries the
 * CF-issued messageId; `ok: false` carries the error for that specific
 * recipient (e.g. one address is unverified while others succeed).
 */
export type SendEmailRecipientResult =
  | { recipient: string; ok: true; messageId: string }
  | { recipient: string; ok: false; error: SendEmailError };

/**
 * Result of `sendEmail`.
 *
 * Three discriminated cases — narrow with `result.ok`, then check whether
 * `'error' in result` (pre-flight failure, no sends attempted) or
 * `'deliveries' in result` (per-recipient failure, some may have succeeded):
 *
 * - `{ ok: true, ids }`            — every envelope succeeded.
 * - `{ ok: false, error }`         — pre-flight failure (validation, MIME,
 *                                     missing binding); no envelopes attempted.
 * - `{ ok: false, deliveries }`    — sends were attempted; at least one failed.
 *                                     `deliveries` carries the per-recipient
 *                                     outcome so callers can safely retry only
 *                                     the failed ones. There is no aggregate
 *                                     top-level error — distinct recipients can
 *                                     fail with distinct errors, and picking one
 *                                     would be arbitrary.
 */
export type SendEmailResult =
  | { ok: true; ids: Array<SendEmailDelivery> }
  | { ok: false; error: SendEmailError }
  | { ok: false; deliveries: Array<SendEmailRecipientResult> };

/**
 * Normalized representation produced by validation, consumed by both the
 * MIME builder and the dev inbox.
 */
export interface NormalizedEmail {
  from: { email: string; name?: string };
  to: Array<{ email: string; name?: string }>;
  cc: Array<{ email: string; name?: string }>;
  bcc: Array<{ email: string; name?: string }>;
  replyTo?: { email: string; name?: string };
  subject: string;
  text?: string;
  html?: string;
  headers: Record<string, string>;
  attachments: Array<NormalizedAttachment>;
  /**
   * Internal-only threading headers, set by `replyEmail`/`buildReplyMessage`.
   * The MIME builder emits these as proper `In-Reply-To` / `References`
   * top-level headers. User-supplied `headers` with these names are
   * always dropped (they're in `RESERVED_HEADERS`); this field is the
   * supported channel for the trusted reply path.
   */
  threading?: {
    inReplyTo?: string;
    references?: string;
  };
}

export interface NormalizedAttachment {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  contentId?: string;
  disposition: 'attachment' | 'inline';
}
