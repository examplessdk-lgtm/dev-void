---
title: SSE Helpers
status: draft
created: 2026-05-08
---

# SSE Helpers

## Summary

Add `void/sse`: a small helper package for producing and consuming
Server-Sent Events from ordinary route handlers.

This is not a realtime data framework. It does not define channels, fanout,
replay storage, cache invalidation, subscriptions, or entity semantics. It only
makes the SSE wire protocol easy to use correctly.

This RFC creates the foundation that higher-level features can compose with:

- `void/sse` owns SSE formatting, stream lifecycle, headers, keepalives, and
  browser `EventSource` ergonomics.
- `void/live` can build on this transport for cross-request fanout, but simple
  SSE routes do not depend on `void/live`.

## Motivation

SSE is simple when the request that opens the stream also owns the producer:

- AI token streaming
- progress updates for one request
- command or deployment logs produced by the same request
- incremental status output

Users can hand-roll a `TransformStream`, but that leaks protocol details and
commonly misses edge cases:

- multi-line `data:` serialization
- `id`, `event`, and `retry` formatting
- keepalive comments
- default response headers
- request aborts and stream cancellation
- rejected writes after a client disconnects
- client-side `EventSource` cleanup and typed JSON parsing

`void/sse` should make the low-level protocol boring while preserving the normal
HTTP route model.

## Non-Goals

`void/sse` does not include:

- Durable Objects
- cross-request fanout
- replay storage
- authorization helpers beyond ordinary route handler code
- query invalidation or database change streams
- framework-specific adapters
- multi-region coordination
- queue-backed delivery guarantees

Libraries and application code can compose these helpers into higher-level
systems. Void's native answer for production-safe cross-request fanout is
specified separately in `void/live`.

## Server API

```ts
import { defineHandler } from 'void';
import { eventStream } from 'void/sse';

export const GET = defineHandler((c) => {
  return eventStream(
    async (stream) => {
      await stream.comment('connected');

      await stream.send({
        event: 'ready',
        data: { now: Date.now() },
      });

      const timer = setInterval(() => {
        void stream.send({ event: 'tick', data: { now: Date.now() } }).catch(() => stream.close());
      }, 1_000);

      await stream.closed;
      clearInterval(timer);
    },
    {
      signal: c.req.raw.signal,
    },
  );
});
```

Proposed exports:

```ts
export type SseMessage = {
  data?: unknown;
  event?: string;
  id?: string;
  retry?: number;
};

export type SseStream = {
  readonly signal: AbortSignal;
  readonly closed: Promise<void>;
  send(message: SseMessage): Promise<void>;
  comment(text?: string): Promise<void>;
  close(): Promise<void>;
};

export function eventStream(
  start: (stream: SseStream) => void | Promise<void>,
  options?: {
    headers?: HeadersInit;
    keepAlive?: boolean | { intervalMs?: number; comment?: string };
    signal?: AbortSignal;
  },
): Response;

export function formatSse(message: SseMessage): string;

export type SseTextMessage = Omit<SseMessage, 'data'> & {
  data?: string;
};

export function formatSseText(message: SseTextMessage): string;

export function getLastEventId(request: Request): string | null;

export class SseStreamClosedError extends Error {}
```

Default response headers:

```http
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
```

`Connection: keep-alive` should not be part of the universal default because it
is not always legal or useful in Fetch/Workers responses. Docs can mention it
for non-Workers deployments where the runtime permits it. `X-Accel-Buffering`
helps when users deploy behind proxies outside Cloudflare; runtimes that reject
or strip it can ignore it.

Keepalives are enabled by default with a conservative 15 second interval. Passing
`keepAlive: false` disables them. Passing an object customizes the interval and
comment text. The implementation must enforce a positive finite interval.

## Client API

```ts
import { connectEventStream } from 'void/sse/client';

const stream = connectEventStream('/api/events', {
  withCredentials: true,
});

stream.on('ready', (event) => {
  console.log(event.data);
});

stream.on('tick', (event) => {
  console.log(event.data.now);
});

stream.close();
```

Proposed exports:

```ts
export type SseClientEvent<T = unknown> = {
  data: T;
  event: string;
  id: string;
  raw: MessageEvent;
};

export type SseEventMap = Record<string, unknown>;

export type SseClient<Events extends SseEventMap = SseEventMap> = {
  on<Name extends Extract<keyof Events, string>>(
    event: Name,
    handler: (event: SseClientEvent<Events[Name]>) => void,
  ): () => void;
  on<T = unknown>(event: string, handler: (event: SseClientEvent<T>) => void): () => void;
  onError(handler: (event: Event) => void): () => void;
  close(): void;
};

export function connectEventStream<Events extends SseEventMap = SseEventMap>(
  url: string | URL,
  options?: {
    withCredentials?: boolean;
    events?: Array<string>;
    parse?: 'json' | 'text' | ((data: string) => unknown);
  },
): SseClient<Events>;
```

The client is a thin `EventSource` wrapper. It should not support custom request
bodies or arbitrary headers because native browser `EventSource` does not.
Users who need custom headers should use cookie auth, signed URLs, or a
fetch-based streaming helper instead.

The wrapper should live at `void/sse/client`. Keeping the browser helper on a
client-only subpath avoids pulling browser globals into server bundles and leaves
`void/sse` as the server/protocol surface. Higher-level features such as
`void/live` can generate type-only descriptors that compose with this helper
without changing the transport package.

The `events` option is client-side ergonomics only. Native `EventSource`
receives every event the server sends; this option can pre-register typed
listener helpers or narrow TypeScript event names, but it cannot filter network
delivery.

## Wire Format

`formatSse()` serializes fields in this order:

1. `id`
2. `event`
3. `retry`
4. `data`

Rules:

- object `data` is JSON-serialized
- string `data` is sent as-is
- multi-line data is split into multiple `data:` lines
- every message ends with a blank line
- comments use `: ${text}\n\n`
- binary data is rejected in v1 because SSE is text-only
- `event` and `id` must not contain CR, LF, or NUL characters
- `retry` must be a non-negative integer
- comment text must be split into separate comment lines or reject CR/LF input
- unsupported values such as functions, symbols, circular objects, and failed
  JSON serialization should reject the write with a clear error

The implementation must validate control fields before formatting. This prevents
accidental frame injection such as an `event` or `id` value containing a newline
followed by another SSE field.

`send()` validation errors are programming errors and must reject with the clear
formatting error. Writes after the stream has been closed must reject with
`SseStreamClosedError`. Writes that fail because the client disconnected should
also reject with `SseStreamClosedError` after resolving `stream.closed`.
Callers that intentionally fire-and-forget writes, timers, or background
producer callbacks must attach `.catch(...)` or await a producer loop that stops
on `stream.signal.aborted`.

Example:

```ts
formatSse({
  id: 'evt_1',
  event: 'post.update',
  data: { id: '123', likes: 10 },
});
```

Produces:

```txt
id: evt_1
event: post.update
data: {"id":"123","likes":10}

```

## Implementation

`eventStream()` uses `TransformStream`:

1. Create `{ readable, writable }`.
2. Return `new Response(readable, { headers })` immediately.
3. Run the user `start()` callback asynchronously.
4. Write encoded frames through a `WritableStreamDefaultWriter`.
5. Track `stream.closed`.
6. On request abort or stream cancellation, abort the internal signal and stop
   keepalives.
7. Catch internal keepalive and close promise rejections so disconnects do not
   leak unhandled rejections.

Lifecycle semantics:

- If `start()` returns, `eventStream()` closes the stream.
- A finite stream can write several events and return.
- A long-lived stream should wait on `stream.closed`, a producer promise, or an
  application-level cancellation signal before returning.
- `stream.closed` resolves when the stream is closed locally or when the client
  disconnects.
- `close()` is idempotent and resolves after local cleanup has been attempted.
- `send()` and `comment()` never silently swallow caller-visible validation
  errors. They reject with `SseStreamClosedError` once the stream is closed or
  the client has disconnected.

Pseudo-code:

```ts
export function eventStream(start, options = {}) {
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const controller = new AbortController();
  const headers = buildSseHeaders(options.headers);
  const keepAlive = normalizeKeepAlive(options.keepAlive);
  let closeResolve;
  const closed = new Promise<void>((resolve) => {
    closeResolve = resolve;
  });
  let closedOnce = false;
  let keepAliveTimer;

  async function close() {
    if (closedOnce) return;
    closedOnce = true;
    controller.abort();
    clearInterval(keepAliveTimer);
    closeResolve();
    await writer.close().catch(() => {});
  }

  options.signal?.addEventListener('abort', () => void close(), { once: true });

  async function write(chunk) {
    if (closedOnce) {
      throw new SseStreamClosedError();
    }
    try {
      await writer.write(chunk);
    } catch (error) {
      await close();
      throw new SseStreamClosedError();
    }
  }

  const stream = {
    signal: controller.signal,
    closed,
    send: async (message) => write(encoder.encode(formatSse(message))),
    comment: async (text = '') => write(encoder.encode(formatComment(text))),
    close,
  };

  if (keepAlive) {
    keepAliveTimer = setInterval(() => {
      void stream.comment(keepAlive.comment).catch(() => close());
    }, keepAlive.intervalMs);
  }

  queueMicrotask(async () => {
    try {
      await start(stream);
    } finally {
      await close();
    }
  });

  return new Response(readable, { headers });
}
```

The real implementation should also handle readable cancellation, rejected
writes, keepalive cleanup, and races between user `close()`, request abort, and
client disconnect.

The pseudo-code omits type details, but the production implementation should
wire the `ReadableStream` cancellation path into `close()`. This is what lets
`stream.closed` resolve promptly when the browser tab closes or `EventSource` is
disposed.

## Hosted Dispatch Behavior

Void-hosted apps must pass `text/event-stream` responses through as streams.

Dispatch should classify streaming behavior per response:

```ts
function isEventStreamResponse(response: Response): boolean {
  return (
    response.headers.get('content-type')?.toLowerCase().split(';', 1)[0].trim() ===
    'text/event-stream'
  );
}
```

This must not be cached by route or pathname. The same route may return SSE for
one request and JSON, HTML, or an error response for another.

Dispatch should apply this classification immediately after a user-worker
response is available, and again after any fallback redispatch that replaces the
response. Once a response is classified as `text/event-stream`, it must take the
streaming passthrough path for the remainder of the request.

For `text/event-stream` responses, dispatch must not:

- call `response.text()`, `response.json()`, `response.arrayBuffer()`, or
  `response.blob()`
- call `response.clone()` for cache population or body inspection
- write static edge cache
- write ISR cache
- populate page-data JSON cache
- run Cloudflare asset-stub fallback body probing
- infer response bytes from the stream body

Safe header mutation is allowed by wrapping the original body once without
inspecting it.

Metering should record request count, status, and duration as usual. Response
bytes should be `0` in v1 unless a future streaming byte meter can count bytes
without consuming or teeing the response body.

## Compatibility

`void/sse` should work in:

- Cloudflare Workers
- local dev through Miniflare/workerd
- Node/Bun/Deno targets when the runtime provides Web Streams

Unlike native live fanout, this helper does not require Cloudflare bindings and
should not force the Cloudflare target.

## Documentation

Add `framework/docs/guide/sse.md` covering:

- basic server stream
- basic client consumption
- `Last-Event-ID`
- keepalives
- auth with cookies or signed URLs
- when plain SSE is enough
- when to use `void/live` for cross-request fanout

## Testing

Unit tests:

- `formatSse()` serializes event, id, retry, string data, object data, and
  multi-line data.
- `formatSseText()` serializes pre-serialized string data without JSON
  serialization while preserving control-field validation.
- `eventStream()` returns correct headers.
- `eventStream()` emits keepalives.
- `eventStream()` enables keepalives by default and disables them with
  `keepAlive: false`.
- stream cancellation resolves `closed` and stops keepalives.
- rejected writes after disconnect do not produce unhandled promise rejections.
- caller-visible writes after close reject with `SseStreamClosedError`.
- validation errors from `send()` reject and are not swallowed as disconnects.
- client wrapper parses JSON and text events.

Integration tests:

- route handler streams multiple events through local dev runtime.
- hosted dispatch passes `text/event-stream` through without body inspection.
- dispatch does not cache, ISR-write, or asset-fallback-probe SSE responses.

## Decisions

- `formatSseText()` exposes a lower-level string-only formatter for callers that
  already serialized JSON while preserving the same control-field validation as
  `formatSse()`.
