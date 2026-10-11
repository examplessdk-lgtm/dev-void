/**
 * The `void dev` email inbox spans TWO OS processes:
 *
 *   Node (Vite dev server)                 workerd (miniflare child)
 *   ----------------------                 -------------------------
 *   emailDevInboxPlugin                    user route -> void/email
 *     owns the inbox buffer                  sendEmail() -> hasActiveSink()
 *     serves GET /__void/inbox               globalThis.__voidEmailSinks__ is
 *                                            EMPTY here (different isolate)
 *
 * So `registerEmailSink` can never be the transport for a real `void dev`
 * send. These tests drive the wire boundary instead: `sendEmail` runs with a
 * raw env shaped like the one workerd sees (no sink registered), and its
 * capture POST is routed into the REAL dev-inbox middleware through a fake
 * `ASSETS` fetcher — which is exactly what `@cloudflare/vite-plugin` binds
 * `env.ASSETS` to in dev (`{ node: (req, res) => viteDevServer.middlewares(req, res) }`).
 */
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { shouldInjectEmailDevInboxVar } from '../../src/index.ts';
import { emailDevInboxPlugin } from '../../src/plugin-email-dev-inbox.ts';
import { sendEmail } from '../../src/runtime/email.ts';
import {
  captureMessage,
  clearDevBuffer,
  DEV_INBOX_ACK_HEADER,
  DEV_INBOX_ACK_VALUE,
  DEV_INBOX_CAPTURE_URL,
  DEV_INBOX_ENV_VAR,
  DEV_INBOX_MAX_CAPTURE_BYTES,
  DEV_INBOX_TOKEN_ENV_VAR,
  DEV_INBOX_TOKEN_HEADER,
  DEV_INBOX_TOKEN_QUERY,
  hasActiveSink,
  listDevMessages,
  parseCapturedMessage,
  pushToDevBuffer,
  serializeCapturedMessage,
  type CapturedMessage,
} from '../../src/runtime/email/dev-inbox.ts';
import {
  buildMime,
  MAX_ADDRESS_LENGTH,
  MAX_MESSAGE_BYTES,
  MAX_RECIPIENTS,
  normalizeEmail,
} from '../../src/runtime/email/mime.ts';
import { withRuntimeEnv } from '../../src/runtime/env.ts';

/** The per-project dev-trigger token `voidPlugin()` hands the plugin. */
const TOKEN = 'dev-token-test';

/** The worker env `mergeBindings` produces under `void dev`: binding var + token var. */
function devEnv(assets: unknown, bindingName = 'ASSETS'): Record<string, unknown> {
  return {
    [DEV_INBOX_ENV_VAR]: bindingName,
    [DEV_INBOX_TOKEN_ENV_VAR]: TOKEN,
    [bindingName]: assets,
  };
}

/** A request that presents the token the way curl and the worker do. */
function authed(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set(DEV_INBOX_TOKEN_HEADER, TOKEN);
  return new Request(url, { ...init, headers });
}

// ---------------------------------------------------------------------------
// A minimal connect-style middleware stack, so the plugin's real
// `configureServer` handler runs against real Node req/res objects.
// ---------------------------------------------------------------------------

type NodeHandler = (req: unknown, res: unknown, next: () => void) => void;

interface FakeServer {
  dispatch(request: Request): Promise<Response>;
}

function createFakeViteServer(): FakeServer {
  const stack: Array<{ route: string; handle: NodeHandler }> = [];
  const server = {
    config: { command: 'serve' as const },
    httpServer: undefined,
    middlewares: {
      use(route: string | NodeHandler, handle?: NodeHandler) {
        if (typeof route === 'function') {
          stack.push({ route: '/', handle: route });
        } else {
          stack.push({ route, handle: handle as NodeHandler });
        }
      },
    },
  };

  const plugin = emailDevInboxPlugin({ devTriggerToken: TOKEN });
  const configureServer = plugin.configureServer as (this: unknown, s: unknown) => void;
  configureServer.call(plugin, server);

  return {
    async dispatch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const entry = stack.find(
        (s) => url.pathname === s.route || url.pathname.startsWith(`${s.route}/`),
      );
      if (!entry) {
        return new Response('no middleware', { status: 404 });
      }
      // connect strips the mounted prefix from req.url.
      const rest = url.pathname.slice(entry.route.length) || '/';
      const bodyBytes = new Uint8Array(await request.arrayBuffer());

      const req = Readable.from(
        bodyBytes.byteLength > 0 ? [Buffer.from(bodyBytes)] : [],
      ) as Readable & {
        url: string;
        method: string;
        headers: Record<string, string>;
      };
      req.url = rest + url.search;
      req.method = request.method;
      req.headers = Object.fromEntries(request.headers.entries());

      return await new Promise<Response>((resolve) => {
        let status = 200;
        let headers: Record<string, string> = {};
        const chunks: Array<Buffer> = [];
        const res = {
          writeHead(code: number, h?: Record<string, string>) {
            status = code;
            if (h) {
              headers = { ...headers, ...h };
            }
            return res;
          },
          setHeader(k: string, v: string) {
            headers[k] = v;
          },
          end(chunk?: Buffer | string) {
            if (chunk) {
              chunks.push(Buffer.from(chunk));
            }
            // A WHATWG Response rejects a body on 204/304, which the plugin's
            // DELETE answers with; node:http has no such rule.
            const body = status === 204 || status === 304 ? null : Buffer.concat(chunks);
            resolve(new Response(body, { status, headers }));
          },
        };
        entry.handle(req, res, () => {
          resolve(new Response('next()', { status: 404 }));
        });
      });
    },
  };
}

/**
 * Stand-in for the dev `env.ASSETS` binding. In a real `void dev` this is a
 * miniflare service binding whose implementation is the Vite dev server's Node
 * middleware stack; here it is the same middleware stack, reached over a real
 * Request/Response pair.
 */
function fakeAssetsBinding(server: FakeServer): {
  fetch(req: Request | string, init?: RequestInit): Promise<Response>;
  calls: Array<{ url: string; method: string }>;
} {
  const calls: Array<{ url: string; method: string }> = [];
  return {
    calls,
    async fetch(req, init) {
      const request = typeof req === 'string' ? new Request(req, init) : req;
      calls.push({ url: request.url, method: request.method });
      return server.dispatch(request);
    },
  };
}

function subjectsInListHtml(html: string): Array<string> {
  return [...html.matchAll(/<a href="\/__void\/inbox\/[^"]+">([^<]*)<\/a>/g)].map((m) => m[1]);
}

function hrefsInHtml(html: string): Array<string> {
  return [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
}

beforeEach(() => {
  clearDevBuffer();
});
afterEach(() => {
  clearDevBuffer();
});

describe('dev inbox capture wire format', () => {
  it('round-trips a captured message through JSON', () => {
    const original: CapturedMessage = {
      id: 'dev_abc',
      capturedAt: 1234,
      raw: new Uint8Array([0, 1, 2, 250, 255]),
      messageId: '<mid@x>',
      from: { email: 'a@x.dev', name: 'A' },
      to: [{ email: 'b@y.dev' }],
      cc: [],
      bcc: [],
      subject: 'hi',
      text: 'body',
      headers: { 'X-Custom': '1' },
      attachments: [
        { filename: 'a.txt', contentType: 'text/plain', size: 3, disposition: 'attachment' },
      ],
    };
    const parsed = parseCapturedMessage(JSON.parse(serializeCapturedMessage(original)));
    expect(parsed).toBeDefined();
    expect(parsed?.id).toBe('dev_abc');
    expect(parsed?.subject).toBe('hi');
    expect([...(parsed?.raw ?? [])]).toEqual([0, 1, 2, 250, 255]);
    expect(parsed?.attachments[0].filename).toBe('a.txt');
    expect(parsed?.headers['X-Custom']).toBe('1');
  });

  it('rejects a malformed payload instead of throwing', () => {
    expect(parseCapturedMessage(null)).toBeUndefined();
    expect(parseCapturedMessage({ id: 1 })).toBeUndefined();
    expect(parseCapturedMessage({ id: 'x', raw: 'not-base64!!!', to: 'nope' })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The capture cap is sized for the SERIALIZED capture, not for the MIME. The
// wire format carries the raw MIME as base64 and every caller string again as
// JSON, and JSON escapes a control character to six bytes where the MIME
// spends three (`=01`, quoted-printable body) or 1.6 (base64 encoded-word
// header). So a message `buildMime` accepts — legal in production — can
// serialize to several times MAX_MESSAGE_BYTES, and a cap that ignores that
// makes `void dev` refuse what a deploy would send.
// ---------------------------------------------------------------------------

/** Serialized capture size of a message, alongside the MIME it was built from. */
async function serializedSizeOf(
  opts: Parameters<typeof normalizeEmail>[0],
): Promise<{ mimeBytes: number; jsonBytes: number }> {
  const normalized = await normalizeEmail(opts);
  const { raw, messageId } = buildMime(normalized);
  const json = serializeCapturedMessage(captureMessage(normalized, raw, messageId));
  return { mimeBytes: raw.byteLength, jsonBytes: Buffer.byteLength(json, 'utf8') };
}

describe('dev inbox capture cap (sized for the serialized capture)', () => {
  // Quoted-printable expands each control byte to `=01` plus soft breaks.
  // The capture also carries JSON-escaped text and base64 MIME, so even a
  // message below the 5 MiB sending limit exceeds three times that budget.
  it('captures a legal message whose serialized capture exceeds three MIME budgets', async () => {
    const text = '\x01'.repeat(Math.floor(MAX_MESSAGE_BYTES / 3.15));
    const server = createFakeViteServer();
    const assets = fakeAssetsBinding(server);
    const result = await withRuntimeEnv(devEnv(assets), () =>
      sendEmail({ from: 'a@x.dev', to: 'b@y.dev', subject: 'control-heavy', text }),
    );
    expect(result).toMatchObject({ ok: true });
    const [message] = listDevMessages();
    expect(message.subject).toBe('control-heavy');
    expect(message.raw.byteLength).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(message.text).toBe(text);
    // What crossed the wire: the same JSON the worker POSTed (ASCII, so its
    // length is its byte size), including both expanded representations.
    expect(serializeCapturedMessage(message).length).toBeGreaterThan(3 * MAX_MESSAGE_BYTES);
  });

  // The bound behind the constant: base64 raw (4/3) plus every caller string
  // at its worst JSON expansion over its own MIME octets (3.75x, a control in
  // an encoded-word header), plus the fields with no MIME footprint (`bcc`
  // addresses, framing). Pinned against the real builder and serializer at a
  // small scale — the ratio is per octet, so it holds at any size — so a new
  // capture field, or a MIME path that stops rendering a string, changes
  // this test before it changes the inbox.
  it('is derived from MAX_MESSAGE_BYTES: base64 raw (4/3) plus caller strings at 3.75x', async () => {
    const worstExpansion = 6 / 1.6;
    expect(DEV_INBOX_MAX_CAPTURE_BYTES).toBe(6 * MAX_MESSAGE_BYTES);
    const framing = 1024;
    const bound =
      (4 / 3 + worstExpansion) * MAX_MESSAGE_BYTES + MAX_RECIPIENTS * MAX_ADDRESS_LENGTH + framing;
    expect(DEV_INBOX_MAX_CAPTURE_BYTES).toBeGreaterThan(bound);
    // ...and the smallest integer multiple that does.
    expect(5 * MAX_MESSAGE_BYTES).toBeLessThan(bound);

    const base = { from: 'a@x.dev', to: 'b@y.dev', subject: 's' };
    const control = '\x01'.repeat(30_000);
    const encodedHeaderShapes: Array<[string, Parameters<typeof normalizeEmail>[0]]> = [
      // encoded-word header: base64 plus framing (1.6) in the MIME, 6 in JSON — 3.75x
      ['control subject', { ...base, subject: control, text: 't' }],
      ['control display name', { ...base, to: [{ email: 'b@y.dev', name: control }], text: 't' }],
      [
        'control custom header value',
        { ...base, headers: { 'X-Note': control.slice(0, 8_192) }, text: 't' },
      ],
    ];
    const shapes: Array<[string, Parameters<typeof normalizeEmail>[0]]> = [
      // body: `=01` (3) in the MIME, `\u0001` (6) in JSON — 2x
      ['control text', { ...base, text: control }],
      // body, 7bit path: CRLF (2) in the MIME, `\r\n` (4) in JSON — exactly 2x
      ['crlf text', { ...base, text: '\r\n'.repeat(30_000) }],
      // body, quoted-printable path: a mid-line HTAB is 1 octet, `\t` in JSON is 2 — 2x
      ['tab text', { ...base, text: '\t'.repeat(30_000) }],
      // custom header names: printable ASCII, `"` is 1 in the MIME and 2 in JSON — 2x
      [
        'quote header names',
        {
          ...base,
          text: 't',
          headers: Object.fromEntries(
            Array.from({ length: 12 }, (_, i) => [`${'"'.repeat(900)}${i}`, 'v']),
          ),
        },
      ],
      ...encodedHeaderShapes,
    ];
    for (const [label, opts] of shapes) {
      const { mimeBytes, jsonBytes } = await serializedSizeOf(opts);
      expect(mimeBytes, label).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
      expect(jsonBytes, label).toBeLessThanOrEqual((4 / 3 + worstExpansion) * mimeBytes + framing);
    }

    // The 3.75x term is load-bearing, not slack: every encoded-header shape
    // serializes past the body-only figure (4/3 + 2), which is why that
    // figure could not have been the ratio.
    for (const [label, opts] of encodedHeaderShapes) {
      const { mimeBytes, jsonBytes } = await serializedSizeOf(opts);
      expect(jsonBytes, label).toBeGreaterThan((4 / 3 + 2) * mimeBytes);
    }
  });
});

describe('sendEmail -> dev inbox (cross-process transport)', () => {
  it('POSTs the captured message to the dev inbox when no in-process sink exists', async () => {
    // This is the shape workerd sees during `void dev`: the Node-side sink
    // registry is unreachable, so hasActiveSink() is false.
    expect(hasActiveSink()).toBe(false);

    const server = createFakeViteServer();
    const assets = fakeAssetsBinding(server);

    const result = await withRuntimeEnv(devEnv(assets), () =>
      sendEmail({
        from: 'Acme <hello@acme.dev>',
        to: 'user@example.com',
        subject: 'Cross-process hello',
        text: 'Hi there',
        html: '<p>Hi there</p>',
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ids).toHaveLength(1);
      expect(result.ids[0].recipient).toBe('user@example.com');
      expect(result.ids[0].messageId).toMatch(/^dev_/);
    }

    expect(assets.calls).toEqual([
      { url: `http://localhost${DEV_INBOX_CAPTURE_URL}`, method: 'POST' },
    ]);

    // ...and the Node-side buffer that `/__void/inbox` renders now has it.
    const messages = listDevMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].subject).toBe('Cross-process hello');
    expect(messages[0].from.email).toBe('hello@acme.dev');
    expect(messages[0].to[0].email).toBe('user@example.com');
    expect(messages[0].html).toBe('<p>Hi there</p>');
    expect(messages[0].raw.byteLength).toBeGreaterThan(0);

    const listed = await server.dispatch(authed('http://localhost/__void/inbox'));
    expect(subjectsInListHtml(await listed.text())).toContain('Cross-process hello');
  });

  // The cross-process capture answers with the same `ids` the in-process
  // sink does — one per unique address, lowercased, as production sends —
  // while the buffered message the inbox renders keeps every field as given.
  it('reports one id per unique address while the buffered message keeps the fields', async () => {
    const server = createFakeViteServer();
    const assets = fakeAssetsBinding(server);
    const result = await withRuntimeEnv(devEnv(assets), () =>
      sendEmail({
        from: 'a@x.dev',
        to: ['A@x.dev'],
        cc: ['a@x.dev'],
        bcc: ['Bob <B@x.dev>', 'b@x.dev'],
        subject: 'dedup-check',
        text: 't',
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ids.map((d) => d.recipient)).toEqual(['a@x.dev', 'b@x.dev']);
    }
    const [message] = listDevMessages();
    expect(message.to).toEqual([{ email: 'A@x.dev' }]);
    expect(message.cc).toEqual([{ email: 'a@x.dev' }]);
    expect(message.bcc).toEqual([{ email: 'B@x.dev', name: 'Bob' }, { email: 'b@x.dev' }]);
  });

  it('serves the captured .eml back from the raw route', async () => {
    const server = createFakeViteServer();
    const assets = fakeAssetsBinding(server);
    await withRuntimeEnv(devEnv(assets), () =>
      sendEmail({ from: 'a@x.dev', to: 'b@y.dev', subject: 'raw-check', text: 'body text' }),
    );
    const id = listDevMessages()[0].id;
    const raw = await server.dispatch(authed(`http://localhost/__void/inbox/${id}/raw`));
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-type')).toBe('message/rfc822');
    expect(await raw.text()).toContain('Subject: raw-check');
  });

  it('acknowledges the capture with a marker header so a plain asset 200 is not mistaken for success', async () => {
    const server = createFakeViteServer();
    const res = await server.dispatch(
      authed(`http://localhost${DEV_INBOX_CAPTURE_URL}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: serializeCapturedMessage({
          id: 'dev_marker',
          capturedAt: Date.now(),
          raw: new Uint8Array([65]),
          messageId: '<m@x>',
          from: { email: 'a@x.dev' },
          to: [{ email: 'b@y.dev' }],
          cc: [],
          bcc: [],
          subject: 'marker',
          headers: {},
          attachments: [],
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get(DEV_INBOX_ACK_HEADER)).toBe(DEV_INBOX_ACK_VALUE);
    expect(listDevMessages()[0].subject).toBe('marker');
  });

  it('reports an honest error when the dev inbox is unreachable — no hang, no crash', async () => {
    const broken = {
      async fetch() {
        throw new Error('socket hang up');
      },
    };
    const result = await withRuntimeEnv(devEnv(broken), () =>
      sendEmail({ from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: 't' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && 'error' in result) {
      expect(result.error.code).toBe('UPSTREAM_ERROR');
      expect(result.error.message).toContain('/__void/inbox');
    }
  });

  it('does not mistake a non-inbox 200 (a real asset response) for a capture', async () => {
    const assetOnly = {
      async fetch() {
        return new Response('<!DOCTYPE html><html></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      },
    };
    const result = await withRuntimeEnv(devEnv(assetOnly), () =>
      sendEmail({ from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: 't' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && 'error' in result) {
      expect(result.error.code).toBe('UPSTREAM_ERROR');
    }
    expect(listDevMessages()).toHaveLength(0);
  });

  it('falls back to the proxy path when the dev-inbox var is absent (production shape)', async () => {
    const server = createFakeViteServer();
    const assets = fakeAssetsBinding(server);
    const result = await withRuntimeEnv({ ASSETS: assets }, () =>
      sendEmail({ from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: 't' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && 'error' in result) {
      expect(result.error.code).toBe('BINDING_MISSING');
    }
    expect(assets.calls).toHaveLength(0);
    expect(listDevMessages()).toHaveLength(0);
  });

  it('honors sendInDev: true by skipping the dev inbox entirely', async () => {
    const server = createFakeViteServer();
    const assets = fakeAssetsBinding(server);
    const result = await withRuntimeEnv(devEnv(assets), () =>
      sendEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        sendInDev: true,
      }),
    );
    expect(assets.calls).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (!result.ok && 'error' in result) {
      expect(result.error.code).toBe('BINDING_MISSING');
    }
  });

  it('uses the binding name the var names, not a hardcoded ASSETS', async () => {
    const server = createFakeViteServer();
    const assets = fakeAssetsBinding(server);
    await withRuntimeEnv(devEnv(assets, 'STATIC_FILES'), () =>
      sendEmail({ from: 'a@x.dev', to: 'b@y.dev', subject: 'named-binding', text: 't' }),
    );
    expect(assets.calls).toHaveLength(1);
    expect(listDevMessages()[0].subject).toBe('named-binding');
  });
});

// ---------------------------------------------------------------------------
// Every inbox route requires the dev-trigger token. Vite's host validation
// admits any IP-literal `Host`, so under `--host` (or a shared port) the
// unauthenticated inbox handed every network peer the raw MIME — Bcc and
// attachments included — plus DELETE and a capture endpoint to plant messages.
// ---------------------------------------------------------------------------

function seeded(): CapturedMessage {
  return {
    id: 'dev_seeded',
    capturedAt: Date.now(),
    raw: new TextEncoder().encode('Subject: seeded\r\nBcc: hidden@bcc.dev\r\n\r\nbody'),
    messageId: '<seeded@x>',
    from: { email: 'a@x.dev' },
    to: [{ email: 'b@y.dev' }],
    cc: [],
    bcc: [{ email: 'hidden@bcc.dev' }],
    subject: 'seeded',
    text: 'body',
    headers: {},
    attachments: [],
  };
}

describe('dev inbox auth (dev-trigger token on every route)', () => {
  const captureInit = (): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: serializeCapturedMessage({ ...seeded(), id: 'dev_planted' }),
  });

  it.each([
    ['GET list', 'http://localhost/__void/inbox', {}],
    ['GET detail', 'http://localhost/__void/inbox/dev_seeded', {}],
    ['GET raw', 'http://localhost/__void/inbox/dev_seeded/raw', {}],
    ['DELETE clear', 'http://localhost/__void/inbox', { method: 'DELETE' }],
    ['POST capture', `http://localhost${DEV_INBOX_CAPTURE_URL}`, captureInit()],
  ] as Array<[string, string, RequestInit]>)(
    '%s: 401 without the token, 401 with a wrong one, and nothing happens',
    async (_label, url, init) => {
      const server = createFakeViteServer();
      pushToDevBuffer(seeded());

      const missing = await server.dispatch(new Request(url, init));
      expect(missing.status).toBe(401);
      expect(missing.headers.get(DEV_INBOX_ACK_HEADER)).toBeNull();
      const body = await missing.text();
      expect(body.split('\n')).toHaveLength(1);
      expect(body).toContain(DEV_INBOX_TOKEN_HEADER);
      expect(body).toContain(`?${DEV_INBOX_TOKEN_QUERY}=`);
      expect(body).not.toContain(TOKEN);

      const wrongHeader = await server.dispatch(
        new Request(url, {
          ...init,
          headers: { ...init.headers, [DEV_INBOX_TOKEN_HEADER]: 'nope' },
        }),
      );
      expect(wrongHeader.status).toBe(401);
      const wrongQuery = await server.dispatch(
        new Request(`${url}?${DEV_INBOX_TOKEN_QUERY}=nope`, init),
      );
      expect(wrongQuery.status).toBe(401);
      // A header that is wrong is not rescued by a query that is right — the
      // header is what the worker and curl send, so it is what gets checked.
      const wrongHeaderRightQuery = await server.dispatch(
        new Request(`${url}?${DEV_INBOX_TOKEN_QUERY}=${TOKEN}`, {
          ...init,
          headers: { ...init.headers, [DEV_INBOX_TOKEN_HEADER]: 'nope' },
        }),
      );
      expect(wrongHeaderRightQuery.status).toBe(401);

      // The refusal had no side effect: the seeded message is still the only one.
      expect(listDevMessages().map((m) => m.id)).toEqual(['dev_seeded']);
    },
  );

  it('serves every route with the token in the header (worker, curl)', async () => {
    const server = createFakeViteServer();
    pushToDevBuffer(seeded());

    const list = await server.dispatch(authed('http://localhost/__void/inbox'));
    expect(list.status).toBe(200);
    expect(subjectsInListHtml(await list.text())).toContain('seeded');

    const detail = await server.dispatch(authed('http://localhost/__void/inbox/dev_seeded'));
    expect(detail.status).toBe(200);
    expect(await detail.text()).toContain('hidden@bcc.dev');

    const raw = await server.dispatch(authed('http://localhost/__void/inbox/dev_seeded/raw'));
    expect(raw.status).toBe(200);
    expect(await raw.text()).toContain('Bcc: hidden@bcc.dev');

    const planted = await server.dispatch(
      authed(`http://localhost${DEV_INBOX_CAPTURE_URL}`, captureInit()),
    );
    expect(planted.status).toBe(200);
    expect(planted.headers.get(DEV_INBOX_ACK_HEADER)).toBe(DEV_INBOX_ACK_VALUE);
    expect(listDevMessages().map((m) => m.id)).toEqual(['dev_planted', 'dev_seeded']);

    const cleared = await server.dispatch(
      authed('http://localhost/__void/inbox', { method: 'DELETE' }),
    );
    expect(cleared.status).toBe(204);
    expect(listDevMessages()).toHaveLength(0);
  });

  it('accepts the token as ?token= so the printed URL works in a browser, and keeps the session in its links', async () => {
    const server = createFakeViteServer();
    pushToDevBuffer(seeded());
    const q = `?${DEV_INBOX_TOKEN_QUERY}=${TOKEN}`;

    const list = await server.dispatch(new Request(`http://localhost/__void/inbox${q}`));
    expect(list.status).toBe(200);
    const listHrefs = hrefsInHtml(await list.text());
    expect(listHrefs).toEqual([`/__void/inbox/dev_seeded${q}`, `/__void/inbox/dev_seeded/raw${q}`]);

    const detail = await server.dispatch(
      new Request(`http://localhost/__void/inbox/dev_seeded${q}`),
    );
    expect(detail.status).toBe(200);
    expect(hrefsInHtml(await detail.text())).toEqual([
      `/__void/inbox${q}`,
      `/__void/inbox/dev_seeded/raw${q}`,
    ]);

    const raw = await server.dispatch(
      new Request(`http://localhost/__void/inbox/dev_seeded/raw${q}`),
    );
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-type')).toBe('message/rfc822');
  });

  it('sendEmail reports the 401 by name when the worker env lacks the token, and nothing is captured', async () => {
    const server = createFakeViteServer();
    const assets = fakeAssetsBinding(server);
    const result = await withRuntimeEnv({ [DEV_INBOX_ENV_VAR]: 'ASSETS', ASSETS: assets }, () =>
      sendEmail({ from: 'a@x.dev', to: 'b@y.dev', subject: 'no-token', text: 't' }),
    );
    expect(assets.calls).toHaveLength(1);
    expect(listDevMessages()).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (!result.ok && 'error' in result) {
      expect(result.error.code).toBe('UPSTREAM_ERROR');
      expect(result.error.message).toContain('dev server responded 401');
      expect(result.error.message).toContain(DEV_INBOX_TOKEN_HEADER);
    }
  });

  it('never hangs on a refusal whose body stalls — the excerpt read has its own deadline', async () => {
    vi.useFakeTimers();
    try {
      const stalled = {
        async fetch() {
          // Status arrives, the body never does.
          return new Response(new ReadableStream({ start() {} }), { status: 401 });
        },
      };
      const pending = withRuntimeEnv(devEnv(stalled), () =>
        sendEmail({ from: 'a@x.dev', to: 'b@y.dev', subject: 'stall', text: 't' }),
      );
      await vi.advanceTimersByTimeAsync(1000);
      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok && 'error' in result) {
        expect(result.error.code).toBe('UPSTREAM_ERROR');
        expect(result.error.message).toContain('dev server responded 401');
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('prints the inbox URL with the token once the dev server is listening', async () => {
    const httpServer = new EventEmitter() as EventEmitter & { address: () => { port: number } };
    httpServer.address = () => ({ port: 5173 });
    const server = { config: { command: 'serve' as const }, httpServer, middlewares: { use() {} } };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const plugin = emailDevInboxPlugin({ devTriggerToken: TOKEN });
      (plugin.configureServer as (this: unknown, s: unknown) => void).call(plugin, server);
      expect(log).not.toHaveBeenCalled();
      httpServer.emit('listening');
      await new Promise((r) => setTimeout(r, 150));
      const output = log.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
      expect(output).toContain(
        `Email inbox: http://localhost:5173/__void/inbox?${DEV_INBOX_TOKEN_QUERY}=${TOKEN}`,
      );
    } finally {
      log.mockRestore();
    }
  });
});

describe('shouldInjectEmailDevInboxVar (dev-only gate)', () => {
  it('injects in dev when email is used and an assets binding exists', () => {
    expect(shouldInjectEmailDevInboxVar('dev', true, 'ASSETS')).toBe(true);
  });

  // `prod` covers every build, `void deploy`, AND `vite preview` (which
  // reports command: 'serve' but runs the built worker, whose assets binding
  // is a real directory rather than a dev-server loopback).
  it('never injects outside the dev server — a production wrangler.json must not carry it', () => {
    expect(shouldInjectEmailDevInboxVar('prod', true, 'ASSETS')).toBe(false);
  });

  it('does not inject when the app does not use void/email', () => {
    expect(shouldInjectEmailDevInboxVar('dev', false, 'ASSETS')).toBe(false);
    expect(shouldInjectEmailDevInboxVar('dev', undefined, 'ASSETS')).toBe(false);
  });

  it('does not inject when there is no assets binding to loop back through', () => {
    expect(shouldInjectEmailDevInboxVar('dev', true, undefined)).toBe(false);
    expect(shouldInjectEmailDevInboxVar('dev', true, '')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Buffer bounds. The dev buffer lives in the Vite dev server's NODE process,
// and it retains each message's full raw MIME plus its decoded text and html.
// A count-only cap of 100 therefore bounds the buffer at ~100 x
// MAX_MESSAGE_BYTES, i.e. gigabytes — enough to OOM `void dev` itself.
// ---------------------------------------------------------------------------

const MIB = 1024 * 1024;

function capturedOfSize(id: string, rawBytes: number, htmlChars = 0): CapturedMessage {
  return {
    id,
    capturedAt: Date.now(),
    raw: new Uint8Array(rawBytes),
    messageId: `<${id}@x>`,
    from: { email: 'a@x.dev' },
    to: [{ email: 'b@y.dev' }],
    cc: [],
    bcc: [],
    subject: id,
    ...(htmlChars > 0 && { html: 'x'.repeat(htmlChars) }),
    headers: {},
    attachments: [],
  };
}

describe('dev inbox buffer bounds', () => {
  it('evicts on the retained-byte budget well below the count cap', () => {
    // 8 MiB of raw MIME + 8 MiB of decoded html is 16 MiB charged per message,
    // so the fifth push crosses the 64 MiB budget and evicts — at a count of
    // five, nowhere near the 100-item cap that used to be the only bound.
    for (let i = 1; i <= 5; i++) {
      pushToDevBuffer(capturedOfSize(`msg-${i}`, 8 * MIB, 8 * MIB));
    }
    const retained = listDevMessages();
    expect(retained).toHaveLength(4);
    // listDevMessages() is newest-first: the send that just happened survives,
    // and the oldest is the one that went.
    expect(retained[0].id).toBe('msg-5');
    expect(retained.map((m) => m.id)).not.toContain('msg-1');
  });

  it('keeps the newest message even when it alone exceeds the budget', () => {
    pushToDevBuffer(capturedOfSize('small', 1024));
    pushToDevBuffer(capturedOfSize('huge', 1024, 70 * MIB));
    // A send must always be visible in the inbox, whatever its size.
    const retained = listDevMessages();
    expect(retained).toHaveLength(1);
    expect(retained[0].id).toBe('huge');
  });

  it('resets the byte accounting in clearDevBuffer', () => {
    for (let i = 1; i <= 5; i++) {
      pushToDevBuffer(capturedOfSize(`big-${i}`, 8 * MIB, 8 * MIB));
    }
    clearDevBuffer();
    // A stale counter would leave the buffer permanently over budget, so every
    // later push would evict its predecessor and the inbox would silently show
    // exactly one message.
    for (let i = 1; i <= 3; i++) {
      pushToDevBuffer(capturedOfSize(`small-${i}`, 1024));
    }
    expect(listDevMessages().map((m) => m.id)).toEqual(['small-3', 'small-2', 'small-1']);
  });
});
