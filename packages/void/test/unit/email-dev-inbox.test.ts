/**
 * The `void dev` email inbox spans TWO OS processes:
 *
 *   Node (Vite dev server)                 workerd (miniflare child)
 *   ----------------------                 -------------------------
 *   emailDevInboxPlugin                    user route -> void/email
 *     registers the buffer sink              sendEmail() -> hasActiveSink()
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
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { shouldInjectEmailDevInboxVar } from '../../src/index.ts';
import { emailDevInboxPlugin } from '../../src/plugin-email-dev-inbox.ts';
import { sendEmail } from '../../src/runtime/email.ts';
import {
  clearDevBuffer,
  DEV_INBOX_ACK_HEADER,
  DEV_INBOX_ACK_VALUE,
  DEV_INBOX_CAPTURE_URL,
  DEV_INBOX_ENV_VAR,
  hasActiveSink,
  listDevMessages,
  parseCapturedMessage,
  pushToDevBuffer,
  serializeCapturedMessage,
  type CapturedMessage,
} from '../../src/runtime/email/dev-inbox.ts';
import { withRuntimeEnv } from '../../src/runtime/env.ts';

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

  const plugin = emailDevInboxPlugin();
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
            resolve(new Response(Buffer.concat(chunks), { status, headers }));
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

describe('sendEmail -> dev inbox (cross-process transport)', () => {
  it('POSTs the captured message to the dev inbox when no in-process sink exists', async () => {
    // This is the shape workerd sees during `void dev`: the Node-side sink
    // registry is unreachable, so hasActiveSink() is false.
    expect(hasActiveSink()).toBe(false);

    const server = createFakeViteServer();
    const assets = fakeAssetsBinding(server);

    const result = await withRuntimeEnv({ [DEV_INBOX_ENV_VAR]: 'ASSETS', ASSETS: assets }, () =>
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

    const listed = await server.dispatch(new Request('http://localhost/__void/inbox'));
    expect(subjectsInListHtml(await listed.text())).toContain('Cross-process hello');
  });

  it('serves the captured .eml back from the raw route', async () => {
    const server = createFakeViteServer();
    const assets = fakeAssetsBinding(server);
    await withRuntimeEnv({ [DEV_INBOX_ENV_VAR]: 'ASSETS', ASSETS: assets }, () =>
      sendEmail({ from: 'a@x.dev', to: 'b@y.dev', subject: 'raw-check', text: 'body text' }),
    );
    const id = listDevMessages()[0].id;
    const raw = await server.dispatch(new Request(`http://localhost/__void/inbox/${id}/raw`));
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-type')).toBe('message/rfc822');
    expect(await raw.text()).toContain('Subject: raw-check');
  });

  it('acknowledges the capture with a marker header so a plain asset 200 is not mistaken for success', async () => {
    const server = createFakeViteServer();
    const res = await server.dispatch(
      new Request(`http://localhost${DEV_INBOX_CAPTURE_URL}`, {
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
    const result = await withRuntimeEnv({ [DEV_INBOX_ENV_VAR]: 'ASSETS', ASSETS: broken }, () =>
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
    const result = await withRuntimeEnv({ [DEV_INBOX_ENV_VAR]: 'ASSETS', ASSETS: assetOnly }, () =>
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
    const result = await withRuntimeEnv({ [DEV_INBOX_ENV_VAR]: 'ASSETS', ASSETS: assets }, () =>
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
    await withRuntimeEnv({ [DEV_INBOX_ENV_VAR]: 'STATIC_FILES', STATIC_FILES: assets }, () =>
      sendEmail({ from: 'a@x.dev', to: 'b@y.dev', subject: 'named-binding', text: 't' }),
    );
    expect(assets.calls).toHaveLength(1);
    expect(listDevMessages()[0].subject).toBe('named-binding');
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
