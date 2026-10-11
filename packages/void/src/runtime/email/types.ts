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
   * Sender envelope address. Optional. When omitted, `void dev` and
   * `void deploy --platform cloudflare` use `email.from` from void.config.ts,
   * and a Void platform deploy uses `<project-slug>+noreply@<mail-domain>`.
   * Without either, `sendEmail` returns `INVALID_FROM`; it never falls back
   * to a baked-in domain.
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
   * Deduplicates a platform send for 30 days. Reuse the same key and message
   * when checking an uncertain attempt; a changed message is a conflict.
   * Native Cloudflare bindings do not provide this guarantee.
   */
  idempotencyKey?: string;
  /**
   * Per-call escape hatch for local development. When true, bypasses the
   * `void dev` in-memory inbox for this one send.
   *
   * It does not deliver. `void dev` binds no send transport at all: the
   * platform's `__VOID_PROXY` service binding is added only on a deployed
   * worker, and the own-account `SEND_EMAIL` binding is stripped under
   * `serve`. With the inbox skipped there is nothing to fall through to,
   * so the call returns `BINDING_MISSING`. To verify real delivery, deploy
   * and send from the deployed worker.
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
  | 'IDEMPOTENCY_CONFLICT'
  | 'OUTCOME_UNKNOWN'
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
  state?: 'provider_accepted';
}

export type EmailDeliveryState =
  | 'rejected'
  | 'reserved'
  | 'attempt_started'
  | 'provider_accepted'
  | 'failed'
  | 'outcome_unknown'
  | 'cancelled';

/**
 * Per-recipient outcome for a multi-recipient send. `ok: true` carries the
 * CF-issued messageId; `ok: false` carries the error for that specific
 * recipient (e.g. one address is unverified while others succeed).
 */
export type SendEmailRecipientResult =
  | { recipient: string; ok: true; messageId: string; state?: 'provider_accepted' }
  | { recipient: string; ok: false; error: SendEmailError; state?: EmailDeliveryState };

/**
 * Result of `sendEmail`.
 *
 * Three discriminated cases — narrow with `result.ok`, then check whether
 * `'error' in result` (pre-flight failure, no sends attempted) or
 * `'deliveries' in result` (per-recipient failure, some may have succeeded):
 *
 * - `{ ok: true, ids }`            — every envelope succeeded.
 * - `{ ok: false, error }`         — validation or transport failure. An
 *                                     OUTCOME_UNKNOWN may have been submitted;
 *                                     never retry it with a new idempotency key.
 * - `{ ok: false, deliveries }`    — sends were attempted; at least one failed.
 *                                     `deliveries` carries the per-recipient
 *                                     outcome. Provider acceptance does not
 *                                     establish mailbox delivery. Unknown
 *                                     outcomes must not be blindly retried.
 */
export type SendEmailResult =
  | { ok: true; ids: Array<SendEmailDelivery>; operationId?: string }
  | { ok: false; error: SendEmailError; operationId?: string }
  | { ok: false; deliveries: Array<SendEmailRecipientResult>; operationId?: string };

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
