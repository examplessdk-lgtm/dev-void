/**
 * Test harnesses for void/email.
 *
 *   createEmailTestHarness    — captures outbound `sendEmail` calls.
 *   createInboundTestHarness  — delivers a synthesized message through your
 *                                inbound route table and captures any
 *                                replies / forwards / rejects.
 *
 *   import { createEmailTestHarness } from "void/email/testing";
 *   const harness = createEmailTestHarness();
 *   await sendEmail({ from: "a@x.dev", to: "b@y.dev", subject: "hi", text: "yo" });
 *   expect(harness.messages[0].subject).toBe("hi");
 *   harness.dispose();
 *
 *   import { createInboundTestHarness } from "void/email/testing";
 *   const inbound = createInboundTestHarness({
 *     routes: { "support+[ticket]": supportHandler, _default: catchAll },
 *   });
 *   const result = await inbound.deliver({
 *     from: "user@example.com",
 *     // The WIRE address: `<slug>+<tag>@<domain>`, as the platform delivers
 *     // it. The harness strips `<slug>+` before matching, so passing the
 *     // user-facing "support+abc-1@app.dev" would read `support` as the slug.
 *     to: "myslug+support+abc-1@app.dev",
 *     subject: "help",
 *     text: "thanks",
 *   });
 *   expect(result.handler).toBe("support+[ticket]");
 *   expect(result.params).toEqual({ ticket: "abc-1" });
 */

import { compileEmailPattern, type CompiledEmailPattern } from '../../router/email.ts';
import { registerEmailSink, type CapturedMessage } from './dev-inbox.ts';
import type { EmailHandler, EmailHandlerInfo } from './inbound.ts';
import { buildMime, normalizeEmail } from './mime.ts';

export interface EmailTestHarness {
  /** Messages captured since the harness was created (or since the last clear). */
  readonly messages: ReadonlyArray<CapturedMessage>;
  /** Discard captured messages. */
  clear(): void;
  /** Stop intercepting sends. After dispose, real binding sends resume. */
  dispose(): void;
}

export function createEmailTestHarness(): EmailTestHarness {
  const messages: Array<CapturedMessage> = [];
  const unregister = registerEmailSink((m) => {
    messages.push(m);
  });
  return {
    get messages() {
      return messages;
    },
    clear() {
      messages.length = 0;
    },
    dispose() {
      unregister();
      messages.length = 0;
    },
  };
}

export type { CapturedMessage } from './dev-inbox.ts';

// ---------------------------------------------------------------------------
// Inbound test harness
// ---------------------------------------------------------------------------

export interface InboundDeliverOptions {
  from: string;
  to: string;
  subject?: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  /** Override the constructed MIME body. Bytes preferred; strings encoded as UTF-8. */
  raw?: string | Uint8Array;
}

export interface InboundReplyCapture {
  from: string;
  to: string;
  raw: Uint8Array;
}

export interface InboundForwardCapture {
  to: string;
  headers?: Headers;
}

export interface InboundDeliveryResult {
  /** Which handler key matched. `undefined` if the message was not handled. */
  handler?: string;
  params: Record<string, string>;
}

export interface InboundTestHarness {
  readonly replies: ReadonlyArray<InboundReplyCapture>;
  readonly forwards: ReadonlyArray<InboundForwardCapture>;
  readonly rejects: ReadonlyArray<string>;
  readonly deliveries: ReadonlyArray<InboundDeliveryResult>;
  deliver(opts: InboundDeliverOptions): Promise<InboundDeliveryResult>;
  clear(): void;
}

// Reserved key in the `routes` map that is not an address pattern:
//   _default  — fallback handler (mirrors email/_default.ts)

export interface InboundTestHarnessOptions {
  /**
   * Address pattern → handler. Pattern syntax matches the file-based
   * convention: `support`, `support+[ticket]`, `[user]`, `[user]+[tag]`.
   * Reserved key: `_default` (fallback handler, mirrors email/_default.ts).
   */
  routes: Record<string, EmailHandler>;
  /** Forwarded as the second arg to handlers. Defaults to `{}`. */
  env?: unknown;
  /**
   * Project slug used to strip the platform-injected `<slug>+` prefix from
   * `message.to` before handlers see it (mirrors production: the dispatched
   * `message.to` is `<tag>@<domain>`, never `<slug>+<tag>@<domain>`). When
   * omitted, the harness infers the slug from each delivery's recipient
   * (everything before the first `+` in the local-part) so existing tests
   * with synthetic `slug+tag@domain` recipients keep working without
   * configuration.
   */
  slug?: string;
}

interface CompiledRoute {
  key: string;
  pattern: CompiledEmailPattern;
  handler: EmailHandler;
}

const DISPATCH_PRIORITY = {
  'static-tag': 0,
  static: 1,
  'dynamic-tag': 2,
  dynamic: 3,
} as const;

function compileRoutes(routes: Record<string, EmailHandler>): {
  compiled: Array<CompiledRoute>;
  defaultHandler?: EmailHandler;
} {
  const compiled: Array<CompiledRoute> = [];
  let defaultHandler: EmailHandler | undefined;
  for (const [key, handler] of Object.entries(routes)) {
    if (key === '_default') {
      defaultHandler = handler;
      continue;
    }
    const pattern = compileEmailPattern(key);
    if (!pattern) {
      throw new Error(
        `createInboundTestHarness: route key ${JSON.stringify(key)} is not a valid email pattern. Use shapes like "support", "support+[ticket]", "[user]", "[user]+[tag]", or the reserved key "_default".`,
      );
    }
    compiled.push({ key, pattern, handler });
  }
  compiled.sort((a, b) => {
    const pa = DISPATCH_PRIORITY[a.pattern.kind];
    const pb = DISPATCH_PRIORITY[b.pattern.kind];
    if (pa !== pb) {
      return pa - pb;
    }
    return a.key.localeCompare(b.key);
  });
  return { compiled, defaultHandler };
}

async function buildSyntheticRaw(opts: InboundDeliverOptions): Promise<Uint8Array> {
  if (opts.raw !== undefined) {
    return typeof opts.raw === 'string' ? new TextEncoder().encode(opts.raw) : opts.raw;
  }
  // Default: a minimal text/plain message so handlers calling parseEmail()
  // see the expected from/to/subject/body. normalizeEmail requires either
  // text or html — synthesize a placeholder body when neither is supplied.
  const text = opts.text ?? (opts.html ? undefined : '(empty)');
  const normalized = await normalizeEmail({
    from: opts.from,
    to: opts.to,
    subject: opts.subject ?? '',
    text,
    html: opts.html,
    headers: opts.headers,
  });
  return buildMime(normalized).raw;
}

function stripSlugForHarness(address: string, slug: string | undefined): string {
  if (!slug) {
    return address;
  }
  const atIdx = address.indexOf('@');
  if (atIdx <= 0) {
    return address;
  }
  const localPart = address.slice(0, atIdx);
  const domain = address.slice(atIdx);
  const prefix = `${slug.toLowerCase()}+`;
  if (localPart.toLowerCase().startsWith(prefix)) {
    return localPart.slice(prefix.length) + domain;
  }
  return address;
}

function makeReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export function createInboundTestHarness(opts: InboundTestHarnessOptions): InboundTestHarness {
  const { compiled, defaultHandler } = compileRoutes(opts.routes);
  const env = opts.env ?? {};

  const replies: Array<InboundReplyCapture> = [];
  const forwards: Array<InboundForwardCapture> = [];
  const rejects: Array<string> = [];
  const deliveries: Array<InboundDeliveryResult> = [];

  async function deliver(input: InboundDeliverOptions): Promise<InboundDeliveryResult> {
    const raw = await buildSyntheticRaw(input);
    const headers = new Headers(input.headers ?? {});
    if (input.subject && !headers.has('Subject')) {
      headers.set('Subject', input.subject);
    }
    if (!headers.has('From')) {
      headers.set('From', input.from);
    }
    if (!headers.has('To')) {
      headers.set('To', input.to);
    }

    // Mirror production's setReject-is-terminal contract from
    // createMessageProxy: once setReject fires, subsequent forward/reply
    // calls are warned and dropped. Without this flag the harness would
    // record forwards/replies that the real CF runtime silently discards
    // — passing the user's tests for buggy handler code that fails in
    // production.
    // Mirror production: the dispatcher strips the platform-injected
    // `<slug>+` prefix from message.to before user code sees it. When the
    // harness was created with an explicit `slug`, use that; otherwise
    // infer it from this delivery's recipient (the part before the first
    // `+`). Inference keeps existing tests with `slug+tag@domain` recipients
    // working without configuration. Falls back to the verbatim address
    // if no `+` is present.
    const inferredSlug = (() => {
      if (opts.slug) {
        return opts.slug;
      }
      const local = input.to.split('@')[0] ?? '';
      const plus = local.indexOf('+');
      return plus === -1 ? undefined : local.slice(0, plus);
    })();
    const userVisibleTo = stripSlugForHarness(input.to, inferredSlug);

    // Per-delivery records used to walk back forward/reply on setReject —
    // CF treats setReject as terminal, dropping anything queued before it
    // in the same dispatch. The harness mirrors that: prior forward/reply
    // entries from THIS delivery are popped off the public arrays so the
    // audit trail matches what the real router would actually enact.
    const localForwards: Array<InboundForwardCapture> = [];
    const localReplies: Array<InboundReplyCapture> = [];

    let rejected = false;
    const message: ForwardableEmailMessage = {
      from: input.from,
      to: userVisibleTo,
      headers,
      raw: makeReadableStream(raw),
      rawSize: raw.byteLength,
      setReject(reason: string) {
        if (rejected) {
          return; // already rejected; ignore (matches production)
        }
        rejected = true;
        // Drop any forward/reply this handler queued earlier — they never
        // would have run in production. Pop from the public arrays in
        // reverse so indices remain valid as we splice.
        const dropped = localForwards.length + localReplies.length;
        for (let i = localForwards.length - 1; i >= 0; i--) {
          const idx = forwards.lastIndexOf(localForwards[i]);
          if (idx >= 0) {
            forwards.splice(idx, 1);
          }
        }
        for (let i = localReplies.length - 1; i >= 0; i--) {
          const idx = replies.lastIndexOf(localReplies[i]);
          if (idx >= 0) {
            replies.splice(idx, 1);
          }
        }
        localForwards.length = 0;
        localReplies.length = 0;
        if (dropped > 0) {
          console.warn(
            `[void/email] setReject() after ${dropped} forward/reply call(s) — those actions were dropped. ` +
              'CF rejects are terminal: anything queued before setReject() never runs. ' +
              'Move the reject earlier in the handler.',
          );
        }
        rejects.push(reason);
      },
      async forward(forwardTo: string, forwardHeaders?: Headers) {
        if (rejected) {
          console.warn(
            '[void/email] forward() called after setReject() — ignored. ' +
              'CF rejects are terminal: nothing else runs once setReject fires.',
          );
          return;
        }
        const entry = { to: forwardTo, headers: forwardHeaders };
        forwards.push(entry);
        localForwards.push(entry);
      },
      async reply(reply: { from: string; to: string; raw?: unknown }) {
        if (rejected) {
          console.warn(
            '[void/email] reply() called after setReject() — ignored. ' +
              'CF rejects are terminal: nothing else runs once setReject fires.',
          );
          return;
        }
        // The reply EmailMessage carries .from/.to publicly; its raw body
        // isn't part of the public type but we read it best-effort so tests
        // can assert on the threading headers / subject.
        let rawBytes = new Uint8Array(0);
        const r = (reply as { raw?: unknown }).raw;
        if (r instanceof Uint8Array) {
          // Copy into a fresh Uint8Array<ArrayBuffer> to match the field type
          // — instanceof keeps the original ArrayBufferLike variance.
          rawBytes = new Uint8Array(r);
        } else if (typeof r === 'string') {
          rawBytes = new TextEncoder().encode(r);
        }
        const entry = { from: reply.from, to: reply.to, raw: rawBytes };
        replies.push(entry);
        localReplies.push(entry);
      },
    } as unknown as ForwardableEmailMessage;

    const ctx = {
      waitUntil() {
        // no-op
      },
      passThroughOnException() {
        // no-op
      },
    } as unknown as ExecutionContext;

    // Mirror the production dispatcher's slug-strip: in deployed code, the
    // recipient is `<projectSlug>+<tag>@mail.void.cloud` and the platform
    // router strips through the first `+` before matching. The test
    // harness must do the same so tests don't pass against routing paths
    // that can't occur in production.
    // Case is PRESERVED and the patterns carry the `i` flag instead, exactly
    // as the generated dispatcher does (`router/compile.ts`). Lowercasing
    // here would lowercase the CAPTURED groups too, so a handler under test
    // would see `t-42` for `support+T-42@` while production hands it `T-42` —
    // a green test asserting behavior the deployed code does not have.
    const fullLocal = input.to.split('@')[0] ?? '';
    const plus = fullLocal.indexOf('+');
    const local = plus === -1 ? '' : fullLocal.slice(plus + 1);
    // Note: a recipient with no `+` (e.g. `slug@mail.void.cloud`) has no
    // tag to match — production lands at `_default` if defined, otherwise
    // no-op. We mirror that here.

    for (const route of compiled) {
      const re = new RegExp(route.pattern.regexSource, 'i');
      const m = re.exec(local);
      if (!m) {
        continue;
      }
      const params: Record<string, string> = {};
      for (let i = 0; i < route.pattern.paramNames.length; i++) {
        params[route.pattern.paramNames[i]] = m[i + 1];
      }
      const info: EmailHandlerInfo = { params };
      await route.handler(message, env, ctx, info);
      const result: InboundDeliveryResult = { handler: route.key, params };
      deliveries.push(result);
      return result;
    }
    if (defaultHandler) {
      const info: EmailHandlerInfo = { params: {} };
      await defaultHandler(message, env, ctx, info);
      const result: InboundDeliveryResult = { handler: '_default', params: {} };
      deliveries.push(result);
      return result;
    }
    // Nothing matched and there is no `_default`. The generated dispatcher
    // rejects here so the remote MTA gets a non-delivery report
    // (`router/compile.ts`), and the harness has to mirror that or a test
    // for catch-all or anti-spam behavior observes an ACCEPTED message
    // where deployment bounces it. Routed through `setReject` rather than
    // pushed directly, so the terminal-reject semantics stay identical.
    //
    // The reason is byte-for-byte the dispatcher's, built from the WIRE
    // recipient with its original case — that string reaches the sender's
    // DSN, and rebuilding it from the stripped or lowercased address would
    // recreate the divergence class this mirroring exists to prevent.
    message.setReject(
      `no handler matched recipient "${input.to}" — add email/_default.ts to handle unmatched mail`,
    );
    const result: InboundDeliveryResult = { handler: undefined, params: {} };
    deliveries.push(result);
    return result;
  }

  return {
    get replies() {
      return replies;
    },
    get forwards() {
      return forwards;
    },
    get rejects() {
      return rejects;
    },
    get deliveries() {
      return deliveries;
    },
    deliver,
    clear() {
      replies.length = 0;
      forwards.length = 0;
      rejects.length = 0;
      deliveries.length = 0;
    },
  };
}
