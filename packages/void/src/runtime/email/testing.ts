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

import {
  compareEmailRoutes,
  compileEmailPattern,
  type CompiledEmailPattern,
} from '../../router/email.ts';
import { registerEmailSink, type CapturedMessage } from './dev-inbox.ts';
import {
  createMessageProxy,
  type EmailAction,
  type EmailHandler,
  type EmailHandlerInfo,
  MAX_INBOUND_BYTES,
  MAX_INBOUND_HEADERS,
} from './inbound.ts';
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
   *
   * `null` means NO platform prefix at all — a worker deployed on your own
   * Cloudflare account (`void deploy --platform cloudflare`) receives the
   * address the handler author wrote, and the dispatcher matches the full
   * local part: `support@mail.acme.com` reaches `support`, and
   * `support+T-42@mail.acme.com` reaches `support+[ticket]` with `T-42`.
   */
  slug?: string | null;
}

interface CompiledRoute {
  /** The route key as written; named `address` so the route sorts through `compareEmailRoutes`. */
  address: string;
  pattern: CompiledEmailPattern;
  handler: EmailHandler;
}

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
    compiled.push({ address: key, pattern, handler });
  }
  // The scanner's own comparator (`router/email.ts`), so the harness cannot
  // drift from the order the generated dispatcher tries patterns in.
  compiled.sort(compareEmailRoutes);
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

/**
 * Thrown by `parseHeaderBlock` at the first distinct name past its cap —
 * the router's `InboundTooManyHeadersError` (`email-router.ts`).
 */
class InboundTooManyHeadersError extends Error {}

/**
 * Headers of a raw MIME message, up to the first blank line.
 *
 * Unfolds continuation lines (RFC 5322 §2.2.3: a line starting with WSP
 * continues the one before it). Anything it cannot parse is skipped rather
 * than thrown, because a test may deliver deliberately malformed bytes.
 *
 * `maxDistinct` is the router's header-count admission (`buildEnvelope` in
 * `email-router.ts`): it walks the bag Cloudflare built from the wire and
 * refuses at the cap, BEFORE any entry past it is materialized. That bag is
 * a `Headers`, so the unit is the DISTINCT, case-insensitive name — a
 * repeated `Received:` is one entry, and a continuation line is part of the
 * one before it, never its own. The check sits in the same walk, checked
 * before the `set`, so an over-cap message costs this harness the same
 * `maxDistinct + 1` names it costs the router. A name a `Headers` refuses
 * is not in the bag on either side, so it does not count.
 */
function parseHeaderBlock(raw: Uint8Array, maxDistinct: number): Headers {
  const headers = new Headers();
  const text = new TextDecoder().decode(raw);
  const end = text.indexOf('\r\n\r\n');
  const block = end === -1 ? text : text.slice(0, end);
  let distinct = 0;
  let current = '';
  const commit = () => {
    const colon = current.indexOf(':');
    if (colon > 0) {
      const name = current.slice(0, colon).trim();
      let known: boolean;
      try {
        known = headers.has(name);
      } catch {
        // Not a name a Headers object accepts — skip it.
        current = '';
        return;
      }
      if (!known && distinct >= maxDistinct) {
        throw new InboundTooManyHeadersError();
      }
      try {
        headers.set(name, current.slice(colon + 1).trim());
        if (!known) {
          distinct++;
        }
      } catch {
        // Not a value a Headers object accepts — skip it.
      }
    }
    current = '';
  };
  // One line at a time rather than `split`, so the lines past the cap are
  // never materialized either.
  for (let pos = 0; pos <= block.length;) {
    const nl = block.indexOf('\r\n', pos);
    const line = nl === -1 ? block.slice(pos) : block.slice(pos, nl);
    pos = nl === -1 ? block.length + 1 : nl + 2;
    if (line === '') {
      break;
    }
    if (/^[ \t]/.test(line) && current !== '') {
      current += ` ${line.trim()}`;
      continue;
    }
    commit();
    current = line;
  }
  commit();
  return headers;
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

    // The managed router's ADMISSION, before anything else looks at the
    // bytes (`routeInbound` in `email-router.ts`): a message over
    // `MAX_INBOUND_BYTES` is rejected from `rawSize` before its body is
    // read, then `buildEnvelope` refuses one with more than
    // `MAX_INBOUND_HEADERS` distinct names — each with a reject the handler
    // never sees, because it is never invoked. Same order, same reasons, same
    // outcome: one reject, no handler call. Platform lane only — a worker on
    // your own Cloudflare account (`slug: null`) has no router in front of
    // it, so Cloudflare hands the handler everything it accepts.
    //
    // The router prefixes every reason with the zone it serves
    // (`EMAIL_SENDER_DOMAIN`). It is the catch-all rule on that zone, so the
    // wire recipient's domain IS that zone and the harness recovers the label
    // from the address it was given; `void email` is the router's own
    // fallback when the var is unset. The size check reads `byteLength`: it
    // runs BEFORE `parseHeaderBlock` decodes anything.
    //
    // Production's `buildEnvelope` copies every wire header verbatim, so
    // `message.headers` and `message.raw` agree by construction. Start from
    // the bytes for the same reason: the harness's own synthetic MIME
    // carries a generated `Message-ID` that `replyEmail` threads on, and a
    // caller-supplied `raw:` carries the exact wire headers to deliver.
    //
    // A hand-rolled header split rather than postal-mime, so a deliberately
    // malformed `raw:` fixture still reaches the handler instead of
    // throwing PARSE_FAILED inside the harness.
    let headers: Headers;
    if (opts.slug === null) {
      headers = parseHeaderBlock(raw, Infinity);
    } else {
      const at = input.to.indexOf('@');
      const label = at === -1 ? 'void email' : input.to.slice(at + 1).toLowerCase() || 'void email';
      if (raw.byteLength > MAX_INBOUND_BYTES) {
        return refuse(`${label}: message too large (max ${MAX_INBOUND_BYTES} bytes)`);
      }
      try {
        headers = parseHeaderBlock(raw, MAX_INBOUND_HEADERS);
      } catch (e) {
        if (e instanceof InboundTooManyHeadersError) {
          return refuse(`${label}: too many headers (max ${MAX_INBOUND_HEADERS})`);
        }
        throw e;
      }
    }
    // The caller's own headers win, so an explicit override stays an escape
    // hatch. Applied AFTER admission: they are not on the wire, so the
    // router never counted them.
    for (const [k, v] of new Headers(input.headers ?? {})) {
      headers.set(k, v);
    }
    // Subject is NOT re-set from `input.subject`. The bytes already carry it,
    // and they carry it the way the wire does: `buildMime` RFC 2047-encodes a
    // non-ASCII subject, and production hands the handler that encoded form.
    // Overriding with the decoded string here would make
    // `message.headers.get('Subject')` differ between harness and production
    // for any non-ASCII subject — the pattern the guide itself shows.
    if (!headers.has('Subject') && input.subject) {
      headers.set('Subject', input.subject);
    }
    if (!headers.has('From')) {
      headers.set('From', input.from);
    }
    if (!headers.has('To')) {
      headers.set('To', input.to);
    }

    // Mirror production: the dispatcher strips the platform-injected
    // `<slug>+` prefix from message.to before user code sees it. When the
    // harness was created with an explicit `slug`, use that; otherwise
    // infer it from this delivery's recipient (the part before the first
    // `+`). Inference keeps existing tests with `slug+tag@domain` recipients
    // working without configuration. Falls back to the verbatim address
    // if no `+` is present.
    const slug = (() => {
      if (opts.slug === null) {
        return undefined;
      }
      if (opts.slug) {
        return opts.slug;
      }
      const local = input.to.split('@')[0] ?? '';
      const plus = local.indexOf('+');
      return plus === -1 ? undefined : local.slice(0, plus);
    })();

    // The message the handler sees is production's own proxy, built the way
    // the generated `email()` entry builds it: from an envelope and the slug.
    // Everything the proxy enforces — setReject is terminal, the 100-action
    // queue, the address checks (length and shape), the header-record check, the
    // per-reply and per-delivery byte bounds — therefore throws here at the
    // same call, with the same error, as it does after deploy. The proxy also
    // makes `raw` replayable,
    // as the platform lane does.
    //
    // `Object.fromEntries` is what the platform router's `buildEnvelope`
    // does with the native message's headers.
    const { message, getActions } = createMessageProxy(
      {
        from: input.from,
        to: input.to,
        headers: Object.fromEntries(headers),
        raw,
        rawSize: raw.byteLength,
      },
      { slug },
    );

    const ctx = {
      waitUntil() {
        // no-op
      },
      passThroughOnException() {
        // no-op
      },
    } as unknown as ExecutionContext;

    // Mirror the production dispatcher's slug-strip: on the platform the
    // recipient is `<projectSlug>+<tag>@mail.example.com` and the dispatcher
    // strips through the first `+` before matching. The test harness must do
    // the same so tests don't pass against routing paths that can't occur in
    // production. With `slug: null` (own-account deploy) nothing is stripped
    // and the full local part is matched, exactly as the dispatcher does with
    // no `__VOID_PROJECT_SLUG` configured.
    // Case is PRESERVED and the patterns carry the `i` flag instead, exactly
    // as the generated dispatcher does (`router/compile.ts`). Lowercasing
    // here would lowercase the CAPTURED groups too, so a handler under test
    // would see `t-42` for `support+T-42@` while production hands it `T-42` —
    // a green test asserting behavior the deployed code does not have.
    const fullLocal = input.to.split('@')[0] ?? '';
    const plus = fullLocal.indexOf('+');
    const local = opts.slug === null ? fullLocal : plus === -1 ? '' : fullLocal.slice(plus + 1);
    // Note: on the platform a recipient with no `+` (e.g. `slug@mail.example.com`)
    // has no tag to match — production lands at `_default` if defined, otherwise
    // no-op. We mirror that here.

    async function dispatch(): Promise<InboundDeliveryResult> {
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
        return { handler: route.address, params };
      }
      if (defaultHandler) {
        const info: EmailHandlerInfo = { params: {} };
        await defaultHandler(message, env, ctx, info);
        return { handler: '_default', params: {} };
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
      return { handler: undefined, params: {} };
    }

    const result = await dispatch();
    // Recorded once the handler has returned, as production enacts them: a
    // handler that throws leaves nothing — the platform router rejects the
    // message as a handler error, and on your own account the invocation
    // fails before `enactEmailActions` runs.
    record(getActions());
    deliveries.push(result);
    return result;
  }

  // An admission refusal, recorded the way a handler's own `setReject` is:
  // the queue is that one reject, and the delivery is unhandled.
  function refuse(reason: string): InboundDeliveryResult {
    record([{ type: 'reject', reason }]);
    const result: InboundDeliveryResult = { handler: undefined, params: {} };
    deliveries.push(result);
    return result;
  }

  // The proxy already made `setReject` terminal — earlier forward/reply
  // entries purged, later ones dropped — so the queue is exactly what the
  // router would enact. A forward's headers cross the queue as the record
  // the proxy validated; the capture hands them back as `Headers`.
  function record(actions: ReadonlyArray<EmailAction>): void {
    for (const action of actions) {
      switch (action.type) {
        case 'reject':
          rejects.push(action.reason);
          break;
        case 'forward':
          forwards.push({
            to: action.to,
            ...(action.headers ? { headers: new Headers(action.headers) } : {}),
          });
          break;
        case 'reply':
          replies.push({ from: action.from, to: action.to, raw: action.raw });
          break;
      }
    }
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
