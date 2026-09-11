---
title: Live Event Streams
status: draft
created: 2026-05-08
---

# Live Event Streams

## Summary

Add `void/live`: a Durable Object-backed topic fanout primitive for
production-safe cross-request delivery over Server-Sent Events.

`void/live` is not the low-level SSE helper. It composes with `void/sse`:

- `void/sse` formats frames and provides route-owned streaming helpers.
- `void/live` owns shared connection state, topic subscriptions, and publish
  fanout.

It does not define application data semantics. Topics are opaque application
strings such as `post:12`, `comment:2323`, `notifications:user-1`, or
`connection:posts:abc123`. Payloads are application JSON. Higher-level systems
can build typed topics, cache invalidation, live views, list operations, query
refetching, custom replay, and client state management on top.

The core shape is one browser SSE connection with zero or more server-validated
topic subscriptions attached to it. Later unrelated requests, scheduled
handlers, or queue consumers can publish to a specific topic, and only
connections subscribed to that topic receive the event.

This is intentionally more general than one stream per document or one stream
per entity. A single page may watch many records, lists, rooms, or status
objects without opening many `EventSource` connections.

## Motivation

Plain SSE is enough when the stream producer lives inside the same request that
opened the connection. It is not enough for cross-request fanout:

1. Client A opens `GET /live`.
2. Client A subscribes to `post:2323`, `comment_list:13232`, and several other
   topics over the same connection.
3. Client B or a background task sends `POST /mutate`.
4. The mutation publishes to `post:2323`.
5. Only connections subscribed to `post:2323` receive the event.

In production, those requests may run in different Worker isolates. Module-level
event emitters are not reliable shared state. The correct coordination point is
Durable Objects.

The first draft of this RFC modeled one Durable Object instance per stream scope
and one SSE connection per scope. That is too narrow for normalized-cache,
live-view, and dashboard-style applications. Browsers have practical connection
limits, and users should not need one `EventSource` per record or list. V1 must
make topic multiplexing the primary design.

`void/live` should make this pattern explicit and deployable without users
wiring Durable Object classes, bindings, migrations, stream formatting, topic
indexes, connection ids, or publish routing by hand.

## Goals

- Provide production-safe cross-request fanout over SSE.
- Use one SSE connection per browser client or app tab.
- Support dynamic subscribe and unsubscribe operations over a side-channel.
- Fan out by topic so publish cost is proportional to subscribers of that topic,
  not every connected client.
- Keep connection and control endpoints as ordinary Void routes.
- Avoid `.sse.ts` and other transport-specific route conventions.
- Publish directly through generated Durable Object bindings, not through public
  self-fetch routes.
- Support app-wide, per-user, per-document, per-record, per-list, per-room, and
  custom topics.
- Preserve event ordering within a topic.
- Keep topics and payloads application-owned so higher-level libraries can define
  their own validation, event types, cache semantics, and client state behavior.
- Compose with `void/sse` for frame formatting and browser `EventSource`
  ergonomics.
- Keep local dev behavior equivalent to production.

## Non-Goals

- Do not replace plain userland SSE for request-owned streams.
- Do not provide bidirectional application messaging. The control channel only
  manages subscriptions.
- Do not provide global multi-region pubsub in v1.
- Do not guarantee exactly-once delivery.
- Do not define database invalidation, entity subscription, query cache, or
  application-specific semantics.
- Do not provide live queries, normalized-cache integration, list operations,
  presence, rooms, or client state management.
- Do not provide typed topic declarations, generated topic/event maps, or
  Standard Schema validation in core v1.
- Do not guarantee connection continuity across deploys, rollbacks, Worker
  restarts, browser reconnects, or network changes.
- Do not provide durable replay in v1.
- Do not support Node/Bun/Deno targets for native live fanout in v1.
- Do not optimize one extremely hot topic with hundreds of thousands of
  subscribers in v1. That requires sharded fanout or a dedicated pubsub layer.
- Do not ship singleton-specific or route-initial subscription convenience APIs
  in v1. They can be built later on top of the topic subscription protocol.

## V1 Scope

V1 should ship the smallest complete platform primitive:

- topic streams declared with `defineLiveStream({ id })`
- one browser `EventSource` connection per client or app tab
- client-generated `connectionId` values required by `connect()`
- POST-based subscribe and unsubscribe control operations
- owner-key binding between `connect()` and `control()`
- Durable Object-backed topic subscriber rows
- bounded topic fanout grouped by connection
- opaque string topics
- JSON payload delivery
- at-most-once live delivery
- no durable replay
- no native SSE `id` fields

App-wide broadcasts should use an explicit topic, such as
`global:notifications`, instead of a separate singleton hub API in v1. A future
convenience layer may omit `topic` for singleton streams, but it should compile
to the same topic protocol.

Live state is ephemeral and deployment-scoped. If a deploy, rollback, Worker
restart, browser reconnect, or network change drops the stream, clients must
open a new connection and resubmit subscriptions. Applications that need loss
recovery should refetch authoritative state or implement replay above
`void/live` through application-owned storage and endpoints.

## SSE And WebSocket Boundary

`void/live` is the native SSE fanout primitive. It should be chosen when the
browser only needs server-to-client events, native `EventSource` semantics are a
good fit, and the application wants ordinary HTTP routes plus cookie-based auth.

It is not a replacement for `void/ws`. Durable Objects can hibernate WebSocket
connections, but an open SSE response is an in-progress HTTP request. SSE fanout
is a good fit for notifications, object updates, live lists, status updates, and
moderate fanout. Users building bidirectional rooms, presence-heavy
collaboration, high-frequency state sync, or very large hot-topic fanout should
use `void/ws` or a domain-specific pubsub system.

Native SSE cannot receive messages from the browser on the open connection. Any
dynamic subscribe/unsubscribe API therefore needs a separate HTTP control
request. This RFC makes that side-channel explicit instead of pretending SSE is
bidirectional.

## API

Live streams are ordinary server modules composed into normal route handlers.
The stream id is a stable application-chosen string. It scopes topics so two
libraries can both use `post:12` without sharing subscriber state.

```ts
// src/live.ts
import { defineLiveStream } from 'void/live';

export const live = defineLiveStream({
  id: 'app',
});
```

Expose the stream from an ordinary route:

```ts
// routes/live.ts
import { defineHandler } from 'void';
import { live } from '../src/live';

export const GET = defineHandler((c) => live.connect(c));
export const POST = defineHandler((c) => live.control(c));
```

`connect()` opens the SSE response. `control()` accepts subscribe and
unsubscribe operations for an existing connection.

The wire shape is ordinary HTTP:

```ts
const connectionId = crypto.randomUUID();
const events = new EventSource(`/live?connectionId=${encodeURIComponent(connectionId)}`);

await new Promise<void>((resolve, reject) => {
  events.addEventListener('open', () => resolve(), { once: true });
  events.addEventListener('error', () => reject(new Error('live connection failed')), {
    once: true,
  });
});

await fetch('/live', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    connectionId,
    operations: [
      {
        kind: 'subscribe',
        id: 'post-card',
        topic: 'post:2323',
      },
      {
        kind: 'subscribe',
        id: 'comments',
        topic: 'comment_list:13232',
      },
    ],
  }),
});
```

Publish from any server-side code in the same app:

```ts
import { live } from '../src/live';

await live.publish('post:2323', {
  kind: 'updated',
  id: '2323',
  count: 10,
});
```

Unsubscribe over the same control endpoint:

```ts
await fetch('/live', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    connectionId,
    operations: [{ kind: 'unsubscribe', id: 'post-card' }],
  }),
});
```

`publish()` uses Void's server runtime environment context to resolve the
generated Durable Object binding. It is valid inside request handlers, scheduled
handlers, queue consumers, and other server-side code paths that Void runs with
an active runtime env. If code runs outside that context, it should use an
explicit environment form:

```ts
await live.withEnv(env).publish('post:2323', payload);
```

This keeps common route code terse while making tests and non-request entry
points deterministic.

### Control Operation Types

Proposed wire type:

```ts
export type LiveControlRequest = {
  connectionId: string;
  operations: Array<LiveControlOperation>;
};

export type LiveControlOperation =
  | {
      kind: 'subscribe';
      id: string;
      topic: string;
      lastEventId?: string;
    }
  | {
      kind: 'unsubscribe';
      id: string;
    };
```

`id` is a client-chosen subscription id scoped to the connection. Reusing an id
replaces the previous subscription with that id. Replacement is transactional at
the subscription-id level: the previous active subscription remains active until
the new topic is authorized and registered. If the replacement fails, the old
subscription continues unchanged. If the replacement succeeds, the connection
increments that subscription's revision, marks the old revision inactive, and
drops queued deliveries for the stale revision before activating the new topic.

`topic` is required for every v1 subscribe operation. App-wide broadcasts use an
explicit app-wide topic instead of a singleton-specific control shape. Topics
are opaque strings. Core v1 validates that they are bounded strings but does not
interpret their structure.

`lastEventId` is reserved for higher-level reconnect/refetch systems. Core v1
accepts it and exposes it to hooks, but does not replay missed events or provide
a core per-subscription enqueue API.

Proposed response types:

```ts
export type LiveControlResponse =
  | {
      accepted: true;
      connectionId: string;
      results: Array<LiveControlOperationResult>;
    }
  | {
      accepted: false;
      error: LiveControlError;
    };

export type LiveControlOperationResult =
  | {
      ok: true;
      kind: 'subscribe' | 'unsubscribe';
      id: string;
      topic?: string;
    }
  | {
      ok: false;
      kind: 'subscribe' | 'unsubscribe';
      id: string;
      error: LiveControlError;
    };

export type LiveControlErrorCode =
  | 'BAD_REQUEST'
  | 'CONNECTION_CLOSED'
  | 'CONNECTION_NOT_FOUND'
  | 'FORBIDDEN'
  | 'INVALID_SUBSCRIPTION_ID'
  | 'INVALID_TOPIC'
  | 'OWNER_MISMATCH'
  | 'SUBSCRIPTION_LIMIT'
  | 'TOPIC_FULL'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL_ERROR';

export type LiveControlError = {
  code: LiveControlErrorCode;
  message: string;
};
```

Malformed JSON, invalid batch shape, missing connections, closed connections,
and owner mismatches are batch-level failures. Valid batches return a result per
operation. A failed subscribe or unsubscribe operation must not abort unrelated
operations in the same valid batch. `accepted: true` means the batch reached the
connection protocol; callers must inspect each operation result for per-operation
success or failure.

### Publish Types

Proposed runtime shape:

```ts
export type LivePublishOptions = {
  type?: string;
  eventId?: string;
};

export type LiveStream = {
  connect(ctx: CloudContext, options?: LiveConnectOptions): Response | Promise<Response>;
  control(ctx: CloudContext, options?: LiveControlOptions): Response | Promise<Response>;
  publish(topic: string, data: unknown, options?: LivePublishOptions): Promise<void>;
  withEnv(env: unknown): Pick<LiveStream, 'publish'>;
};
```

`type` is an optional application event type copied into the JSON envelope. The
platform validates that it is a bounded string, but does not type or interpret
it. `void/live` v1 does not expose arbitrary native SSE event names because
native `EventSource` has no wildcard listener and multiplexed subscriptions need
one reliable delivery path.

`eventId` is an opaque application value copied into the JSON envelope. Core v1
does not emit native SSE `id` fields and does not persist or replay event ids.

### Client Helper

`void/sse/client` remains a thin `EventSource` wrapper. `void/live` should also
provide a browser helper because dynamic subscriptions require POST control
requests:

```ts
import { connectLiveStream } from 'void/live/client';

const live = connectLiveStream('/live', {
  withCredentials: true,
});

const unsubscribe = await live.subscribe({
  id: 'post-card',
  topic: 'post:2323',
  onEvent(event) {
    if (event.type === 'updated') {
      event.data.count;
    }
  },
});

await unsubscribe();
live.close();
```

The helper should:

- generate and hold a `connectionId`
- open one `EventSource`
- wait until the `EventSource` has opened before sending control operations
- batch subscribe/unsubscribe POST operations issued in the same microtask
- include caller-provided per-subscription `lastEventId` values when
  resubscribing after a reconnect
- stop the SSE connection when no subscriptions remain, unless configured to
  keep it open
- expose hooks for custom fetch and headers on control requests, an
  `EventSource` factory or `withCredentials` option for the SSE connection,
  retry delay, and errors

Higher-level libraries can ignore this helper and implement the documented HTTP
control protocol directly, but they must wait until the SSE connection has
opened before sending control requests. A control request for a connection id
that is not currently open is rejected.

## Composability

The design intentionally separates four layers:

1. Route ownership:
   Users decide which HTTP route opens a stream and accepts control operations.
2. Transport:
   `void/sse` serializes SSE frames.
3. Subscription control:
   `void/live` validates the control protocol, registers subscriptions, and
   detaches them.
4. Fanout:
   `void/live` indexes topics and delivers published events to matching
   subscriptions.

That keeps APIs composable:

- A route can authenticate before calling `stream.connect(c)` or
  `stream.control(c)`.
- A live declaration can enforce stream-local policies in `onConnect` and
  `onSubscribe`.
- A mutation, scheduled handler, or queue consumer can import the same stream
  object and call `stream.publish(topic, payload)`.
- A client can use the `void/live/client` helper or an application-specific
  control protocol.
- Higher-level libraries can build normalized-cache subscriptions or query
  invalidation on top of `void/live` without reimplementing Durable Object
  fanout.

## Runtime Model

Each `defineLiveStream()` call creates a lightweight stream descriptor. The app
gets one generated `void/live` Durable Object class and one Durable Object
binding when the build uses `void/live`.

Avoiding one Durable Object class per stream is intentional. Stream
declarations are product-level concepts and may grow with application features;
Durable Object classes and bindings are infrastructure-level resources with
platform limits, migration history, and rename/removal churn. A single generated
class keeps the public API flexible.

The generated Durable Object class should support two instance roles:

- connection instances
- topic instances

Instance identity:

- connection instance: stream id plus connection id
- topic instance: stream id plus canonical topic key

The connection instance owns:

- one active SSE response for a connection id
- the active connection generation
- connection cleanup
- the authenticated owner key for the active connection
- subscription ids for that connection
- active/inactive subscription state
- per-subscription revisions for id reuse
- per-connection event queue and slow-consumer handling
- per-subscription last seen application event ids, when supplied
- heartbeat comments
- delivery to the browser

The topic instance owns:

- topic subscriber index
- topic-level event ordering
- publish-time fanout to connection instances
- pruning stale subscribers when delivery fails
- durable subscriber index storage with last-seen timestamps

This two-role model avoids the two failure modes of simpler designs:

- One Durable Object for the entire stream would make every topic share one hot
  global bottleneck.
- One Durable Object per topic cannot by itself hold one SSE connection
  subscribed to many topics.

Publish flow:

1. `publish(topic, payload, options?)` validates the topic string, payload JSON
   serializability, optional application event type, and optional application
   event id.
2. The runtime derives the canonical topic key from the stream id and topic.
3. The publisher sends the message to the topic Durable Object instance.
4. The topic instance serializes the shared payload once and looks up matching
   subscribers.
5. The topic instance groups matching subscriptions by connection instance and
   sends one delivery request per connection with the subscription ids that
   should receive the event.
6. Each connection instance enqueues the event for its SSE response.
7. `publish()` resolves after bounded enqueue attempts have completed or stale
   subscribers have been pruned, not after every browser flushes bytes.

Subscribe flow:

1. `connect(c)` opens or replaces the active SSE response for the connection id.
2. The connection instance increments the connection generation, stores the
   connection's owner key, and marks any existing subscriptions inactive until
   the client resubmits them.
3. `control(c)` validates the request and resolves the same connection instance.
4. `control(c)` validates topic and subscription options, enforces request
   limits, and runs `onSubscribe` in the user's route-handler context for each
   subscribe operation.
5. `control(c)` sends only authorized operations, the resolved owner key, and
   the compact protocol metadata to the connection Durable Object.
6. The connection instance rejects the batch unless the request owner key matches
   the active connection owner key.
7. For subscribe operations, the connection instance enforces per-connection
   limits and asks the topic instance to register the subscription using the
   active connection generation and a per-subscription revision.
8. The topic instance atomically prunes known-stale rows, checks the per-topic
   subscription cap, persists the subscriber row, and returns success or a
   per-operation failure such as `TOPIC_FULL`.
9. Only after topic registration succeeds does the connection instance mark the
   subscription active.
10. Unsubscribe removes the subscription from the connection instance and
    best-effort unregisters it from the topic instance.

The topic subscriber index must not be memory-only. A topic Durable Object can
be evicted while connection Durable Objects remain active because the topic
object is only touched during subscribe, unsubscribe, and publish operations.
Subscribe should therefore persist subscriber references in the topic object's
storage with a `lastSeenAt` timestamp, hydrate the in-memory index from storage
when needed, and prune stale rows on delivery failure or alarm. This makes a
cold topic publish slower, but it avoids silently dropping events after a topic
object restart.

The client-facing route returns a `ReadableStream` response with SSE headers.
The publisher path uses the generated `void/live` Durable Object binding
directly. It must not self-fetch the public connection route.

### Topic Identity

Topics are application-owned opaque strings. Core v1 does not define topic
syntax beyond bounded length and disallowing control characters. Applications
and libraries may encode structured topics however they want, for example:

```txt
post:12
comment:2323
notifications:user-1
connection:posts:4f7a...
```

The final Durable Object name should be derived from both the stable stream id
and the topic string. Implementations should use a deterministic digest instead
of embedding raw topics directly. This avoids name length problems and prevents
potentially sensitive topic identifiers from appearing in infrastructure logs.

### Connection Identity

Clients need a stable, high-entropy connection id so the POST control channel
can target the same live connection as the GET stream. V1 always requires the
client to send this id when opening the SSE connection. The `void/live/client`
helper should generate it. Applications implementing the protocol directly may
generate their own.

Connection ids are not authentication. The server must authorize the GET and
each POST control request through ordinary request auth, and cookie-authenticated
control endpoints should use the same CSRF/origin protections as other
state-changing routes. `connect()` should reject missing or malformed connection
ids before opening an SSE stream, and the connection Durable Object should
reject control operations for a missing or closed connection.

For streams that expose `control()`, the connection must also be bound to an
owner key:

- By default, Void derives the owner key from shared auth when `ctx.user` is
  available.
- Apps using custom auth can pass the same `owner` option to `connect()` and
  `control()`, or define an `identifyConnection(ctx)` hook on the live stream.
- If no owner key is available, `control()` is rejected unless the stream
  explicitly opts into anonymous control.
- Anonymous control still requires same-origin/CSRF protection and a
  high-entropy connection id. It is intended for public dashboards and local
  tools, not user-private data.

The owner key type is `string | null`. Non-null keys must be stable normalized
strings, bounded in length, and safe to store in Durable Object storage. They
should identify the authenticated principal or session, not contain bearer
secrets. Apps should prefer app-namespaced values such as `user:${userId}` or
`session:${sessionId}`. `null` is only valid when anonymous control is
explicitly enabled for that stream.

The connection Durable Object stores the owner key when the SSE response opens.
Every control request must carry the owner key resolved from that request, and
the connection Durable Object must reject mismatches before processing any
operation. This prevents one authenticated user from mutating another user's
open stream even if a connection id leaks through logs or browser state.

When a new GET arrives for an existing connection id, the connection instance
should close the previous SSE response, increment the connection generation, and
replace it. Existing subscription metadata may remain attached so reconnect and
resubscribe can be efficient, but all retained subscriptions must be marked
inactive before delivery resumes and the connection instance should best-effort
unregister the previous active topic rows. The client helper must resubmit
active subscriptions after reconnect, and each resubmitted subscription must
pass `onSubscribe` again. If the new GET resolves to a different owner key, the
connection instance must drop previous subscription metadata instead of reusing
it.

Topic subscriber rows must include the connection generation and subscription
revision that registered the subscription. Reusing a subscription id increments
that subscription's revision, so stale topic rows from the previous topic cannot
deliver under the reused id. When a topic instance fans out to a connection
instance, the connection instance must reject rows whose generation is no longer
current, whose revision no longer matches, or whose subscription is inactive.
The topic instance should prune those stale rows. Subscription caps must count
only active, non-stale rows after pruning, so reconnect churn, owner changes, or
subscription id reuse cannot permanently consume topic capacity.

### Authorization

Connection auth and subscription auth are separate.

`identifyConnection` resolves the internal owner key for streams that expose
`control()`. `onConnect` runs before the SSE response opens:

```ts
export const live = defineLiveStream({
  id: 'app',
  identifyConnection(ctx) {
    return ctx.user?.id ?? null;
  },
  async onConnect(ctx) {
    if (!ctx.user) {
      return new Response('Unauthorized', { status: 401 });
    }
  },
});
```

`onSubscribe` runs inside `control()` before an authorized topic subscription is
sent to the Durable Object for registration:

```ts
export const live = defineLiveStream({
  id: 'app',
  async onSubscribe(ctx) {
    const match = /^post:(.+)$/.exec(ctx.topic);
    if (match) {
      const allowed = await canReadPost(ctx.env, ctx.user, match[1]);
      if (!allowed) {
        return new Response('Forbidden', { status: 403 });
      }
    }
  },
});
```

Context:

```ts
ctx.request;
ctx.env;
ctx.user;
ctx.owner;
ctx.connection.id;
ctx.subscription.id;
ctx.topic;
ctx.lastEventId;
```

For `onConnect`, `ctx.request` is the original GET request. For `onSubscribe`,
`ctx.request` is the original POST control request. The public JSON body has
already been parsed and should not be read again by hooks. Hooks should use
`ctx.topic`, `ctx.lastEventId`, `ctx.owner`, and the route-side auth context
instead of reparsing the control body.

Routes can still authenticate and authorize before calling `connect()` or
`control()`. The hooks exist for stream-local policy and for libraries that want
the live declaration to own access rules.

If route-level auth is custom and cannot be represented by `ctx.user`, routes
should pass an explicit owner key:

```ts
export const GET = defineHandler(async (c) => {
  const session = await requireSession(c);
  return live.connect(c, { owner: `user:${session.userId}` });
});

export const POST = defineHandler(async (c) => {
  const session = await requireSession(c);
  return live.control(c, { owner: `user:${session.userId}` });
});
```

The owner key is not sent to the browser. It is an internal comparison value
used by the connection Durable Object.

Hook execution and auth propagation must be explicit because Durable Object
calls do not preserve a Hono request context automatically:

- `connect()` and `control()` run first in the user's route handler context.
  They resolve the owner key from Void auth, `identifyConnection(ctx)`, or an
  explicit `owner` option.
- `onConnect` runs before dispatching to the connection Durable Object. This
  keeps connection-level rejections as ordinary HTTP responses and lets custom
  route auth participate without serializing a Hono context.
- `onSubscribe` also runs in `control()` before Durable Object dispatch. This
  lets hooks import arbitrary application modules, use the original request
  context, and avoid a generated hook registry inside the shared Durable Object.
- `control()` sends an internal control envelope to the connection Durable
  Object containing the resolved owner key and the operation batch after
  route-side validation and hook authorization.
- For built-in Void auth, the hook context contains the Better Auth user and
  session state already resolved for the request.
- For custom auth, routes may pass a `user` value alongside `owner`. If they do
  not, `ctx.user` is `null` inside `onSubscribe`, and the hook should authorize
  from `ctx.owner`, `ctx.env`, and application storage.
- The connection Durable Object must not run application hooks and must not trust
  any owner, user, or authorization field supplied directly by the browser
  request body.

Example with custom auth that exposes a small user snapshot to `onSubscribe`:

```ts
export const GET = defineHandler(async (c) => {
  const session = await requireSession(c);
  return live.connect(c, {
    owner: `user:${session.userId}`,
    user: { id: session.userId, role: session.role },
  });
});

export const POST = defineHandler(async (c) => {
  const session = await requireSession(c);
  return live.control(c, {
    owner: `user:${session.userId}`,
    user: { id: session.userId, role: session.role },
  });
});
```

The hook auth context is trusted only because it is produced by the server helper
in the route handler. It is not part of the public control protocol and is not
accepted from the browser request body.

### Environment Resolution

The generated live stream object should be a lightweight descriptor plus runtime
helpers. It must not store a concrete Durable Object namespace at module
initialization time.

At runtime:

- `connect(c, options?)` resolves the binding from `c.env`.
- `control(c, options?)` resolves the binding from `c.env`.
- `publish(...)` resolves the binding from Void's active runtime env context.
- `withEnv(env)` returns a stream handle bound to that explicit env.

If no runtime env is available, `publish(...)` should throw a clear error:

```txt
void/live: publish() was called outside a Void server runtime context. Pass an
explicit env with stream.withEnv(env).publish(...).
```

This model allows the same stream declaration to be imported from route
handlers, scheduled handlers, queue consumers, tests, and other server-only code
without relying on global mutable binding state.

## Event Format

`void/live` uses standard SSE frames. Normal publish delivery always uses the
native SSE `message` event in v1. The `data` field is a JSON envelope so clients
can route the event to the right subscription:

```txt
event: message
data: {"subscriptionId":"post-card","topic":"post:2323","type":"updated","data":{"id":"2323","count":10}}

```

Proposed envelope:

```ts
export type LiveClientEvent<Data = unknown> = {
  subscriptionId: string;
  topic: string;
  type?: string;
  eventId?: string;
  data: Data;
};
```

Event envelopes include the topic string so clients can route events when one
connection multiplexes many subscriptions. Payload shape and optional `type`
values are application-owned.

Subscribe-time failures are returned in the `control()` JSON response, not sent
over SSE. The native `EventSource` `error` event is reserved for transport
errors. V1 does not define a core asynchronous subscription-error event,
permission-revocation event, or forced subscription-close API. Higher-level
protocols may model those semantics in userland by publishing application events
on their own topics.

Rules:

- topics are bounded strings validated before subscribe and publish
- payloads must be JSON-serializable
- payloads are JSON-serialized as SSE `data`
- normal publish delivery uses native SSE `event: message`
- `type` is an optional application event type inside the JSON envelope, not a
  native SSE event name
- optional application event ids are carried as `eventId` inside the JSON
  envelope, not as native SSE `id` fields
- native SSE `Last-Event-ID` on the GET stream is ignored by `void/live` because
  a single `EventSource` connection multiplexes many subscriptions; resumable
  state belongs in per-subscription `lastEventId` control operations
- `void/live` should not emit native SSE `id` fields in v1
- core v1 does not persist event ids or replay missed messages

The low-level frame formatting should use the same implementation as
`void/sse`.

## Connection Lifecycle

`connect()` returns a streaming `Response` after pre-stream validation has
completed. It may also return a normal non-streaming error response, such as
`401 Unauthorized`, `403 Forbidden`, or `400 Bad Request`, before any SSE bytes
are sent.

Connection setup order:

1. Resolve the generated Durable Object binding from `c.env`.
2. Parse and validate the client-provided connection id.
3. Resolve connection context, including `ctx.user` and the owner key when Void
   auth or an explicit owner option is available.
4. Run the optional `onConnect` hook.
5. If `onConnect` returns a `Response`, return that response without opening an
   SSE stream.
6. Dispatch to the connection Durable Object.
7. The connection Durable Object replaces any previous SSE response for the same
   connection id, increments the connection generation, stores the owner key,
   marks existing subscriptions inactive, starts heartbeats, and sends an
   initial `: connected\n\n` comment.
8. Return the streaming `text/event-stream` response.

This ordering is required. Auth, missing or malformed connection ids, and other
connection-level rejections must stay ordinary HTTP responses so clients do not
see a successful `EventSource` followed by an application-level error event.
V1 does not generate transient server-side connection ids; every `connect()`
call must identify the connection that future control requests will target.

`control()` setup order:

1. Resolve the generated Durable Object binding from `c.env`.
2. Parse and validate the control request body.
3. Resolve request context, including `ctx.user` and the owner key.
4. Validate subscription ids, topics, per-request operation limits, owner
   availability, and any stream configuration that can be checked before Durable
   Object dispatch.
5. Run `onSubscribe` in the route handler context for each subscribe operation.
6. Dispatch the authorized batch to the connection Durable Object.
7. The connection Durable Object rejects the batch if the connection is missing,
   not currently open, closed, or owned by a different owner key.
8. For subscribe operations, request registration from the topic Durable Object.
9. The topic Durable Object atomically enforces the per-topic subscription cap and
   persists the subscriber row before the connection marks the subscription
   active.
10. Return a stable JSON response. Batch-level failures use the batch error
    shape; valid batches return a result per operation. A failed subscription
    must not abort unrelated operations in the same batch.

`inactive` is subscription state, not connection state. A reconnect marks
retained subscriptions inactive, but the connection itself is open and must
accept resubscribe control operations from the matching owner key. Publish
delivery ignores inactive subscriptions until a resubscribe operation validates
and activates them again.

The connection Durable Object should:

- send an initial `: connected\n\n` comment
- keep at most one active SSE response for a connection id
- increment and store a connection generation whenever an SSE response opens
- remove or mark the active connection closed when the stream is cancelled
- store and compare the owner key for control requests
- mark retained subscriptions inactive on reconnect and require resubscribe
  before delivery resumes
- reject delivery attempts for stale generations or inactive subscriptions
- close the writer when the request signal aborts
- send heartbeat comments every 15 to 30 seconds by default
- maintain a bounded queue per connection
- track subscriptions by subscription id
- increment the subscription revision whenever a subscription id is reused
- best-effort unregister subscriptions on disconnect

The topic Durable Object should:

- store active subscriber references by topic key, connection id, subscription
  id, connection generation, and subscription revision in Durable Object storage
- hydrate its in-memory subscriber index from storage after restart
- enforce `max subscriptions per topic` inside the topic instance, not inside
  connection instances, because concurrent connection instances can race
- prune subscribers when delivery fails or a connection reports no active SSE
  response, stale generation, or inactive subscription
- run an alarm to clear stale subscriber entries
- avoid reading or writing user payloads after enqueue

## Backpressure

Each connection should have a bounded queue.

Suggested defaults:

- max subscriptions per connection: `256`
- max subscriptions per topic: `64`
- max operations per control request: `100`
- max queued events per connection: `100`
- max encoded event size: `64 KiB`
- delivery attempt timeout per connection instance: `1_000` to `2_000` ms
- slow consumer policy: close that connection

These are v1 safety limits, not long-term product ceilings. They should be
configurable per stream, but the implementation must ship with conservative
defaults so a single topic Durable Object cannot become an unbounded memory,
storage, or internal-request fanout point. `64` is intentionally conservative:
it leaves room for the topic Durable Object request, storage reads/writes,
stale pruning, and future runtime overhead under Workers subrequest limits. A
subscribe operation that would exceed `max subscriptions per topic` must fail
with a per-operation `TOPIC_FULL`-style error. Existing subscribers continue to
receive events.

The effective per-topic cap must also respect the platform's internal
subrequest budget. Publishing to a topic performs one topic Durable Object
request plus up to one connection Durable Object request per matching
connection, not per matching subscription. Storage or pruning work may add more
internal operations. The runtime should reject or clamp stream configuration
that cannot fit within the configured Workers subrequest limit with reserved
headroom. A high configured cap is only valid when the deployment target has an
explicitly high enough subrequest budget.

Publishing must not block indefinitely on one slow client. A stalled connection
must not prevent delivery to other subscribers of the same topic.

`publish()` semantics:

1. validate topic, application event type, application event id, and payload
2. canonicalize the topic key
3. serialize the event payload once and derive per-subscription envelopes only
   for active matching subscriptions
4. group matching subscriptions by connection instance
5. enqueue the frame for each active matching subscription by calling each
   matching connection Durable Object once in bounded batches
6. time out individual delivery attempts that exceed the configured delivery
   deadline, mark those subscriber rows stale or suspect, and continue fanout
7. close or prune connections whose queue is already full or whose writer has
   failed
8. resolve after enqueue attempts have completed, timed out, or been pruned, not
   after every browser socket flushes bytes

The topic Durable Object should cap internal fanout concurrency, for example
with batches of `32` to `64` connection-instance calls. That keeps one publish
from generating an unbounded number of simultaneous internal requests. For
larger fanout than v1 allows, applications should use `void/ws`, sharded topics,
or a dedicated pubsub layer.

Topic-local ordering still has priority over fanout parallelism. A topic Durable
Object must serialize publish operations for its topic: publish N+1 must not
start fanout until enqueue attempts for publish N have completed or been pruned.
Bounded batches limit concurrency within one publish; they must not allow later
publishes to overtake earlier publishes for the same topic.

Serialization also needs a failure budget. A topic publish must not wait
indefinitely for a connection instance call, storage operation, or unregister
attempt. Timed-out delivery attempts are treated like failed delivery for that
publish, and later publishes may proceed after the timeout path has recorded
enough state to avoid immediately retrying an obviously stale row.

`publish()` should not wait for every client socket to flush bytes over the
network. The guarantee is "enqueue attempted for currently connected, active,
non-overflowed subscriptions that were accepted by the subscription protocol",
not durable delivery.

## Replay

Live delivery is at-most-once by default. Core v1 does not provide durable
replay and should not reserve a core replay configuration shape.

`lastEventId` is accepted on subscribe operations and exposed to
`onSubscribe()` so higher-level libraries can decide whether to accept the
subscription and whether the client should refetch authoritative state.
`eventId` passed to `publish()` is copied into the JSON envelope for the same
reason. Core does not interpret those ids, persist them, assign monotonic
counters, emit native SSE `id` fields, or enqueue replay events to an individual
subscription.

Applications that need loss recovery should either refetch authoritative state
after reconnect or store replay data in userland infrastructure exposed through
a separate application endpoint or a higher-level protocol.

## Generated Infrastructure

`void/live` needs generated infrastructure because each app that uses it
requires a shared Durable Object class and binding. It should not need a special
source directory, route suffix, or generated topic registry.

Activation:

- any non-type server build graph import of `void/live` marks the app as needing
  the shared live Durable Object
- imports of `void/live/client` do not activate server live infrastructure
- `defineLiveStream({ id })` creates a stream descriptor and registers the stable
  stream id in the server bundle; duplicate stream ids fail build or startup
- stream ids are stable user-provided strings
- users compose streams into whichever routes they want

Generated artifacts:

- one shared Durable Object class export when `void/live` is used
- one shared Durable Object binding when `void/live` is used
- minimal runtime metadata that maps the stream id to the binding

Deploy manifest:

```ts
live: {
  className: 'VoidLiveStreamDurableObject',
  bindingName: 'VOID_LIVE',
  storage: 'sqlite',
  classes: ['VoidLiveStreamDurableObject'],
  migrations: [
    {
      tag: 'live-v1',
      newSqliteClasses: ['VoidLiveStreamDurableObject'],
    },
  ],
}
```

The platform API should provision this with the same Durable Object
upload/migration machinery used for other generated Durable Object features, but
model it under `live`.

The generated live Durable Object should be SQLite-backed in v1. Subscriber
indexes need queryable rows, stale-row pruning, and cap checks, and
SQLite-backed Durable Objects are the portable default across Workers plans. The
deploy manifest must therefore use the existing SQLite Durable Object migration
path (`new_sqlite_classes` in Cloudflare upload metadata) rather than the legacy
key-value Durable Object path.

Removing all live stream declarations must not remove the shared generated
class once it has shipped. The class is an infrastructure resource for the app,
and stale stream-level subscriber data can be garbage-collected by alarms or
future maintenance tasks. Migration tags must follow the same chronological
ordering rules as other Durable Object migrations so unrelated features cannot
reorder a class creation after deploys have shipped.

Runtime schema inside the live Durable Object should be initialized
idempotently, for example with a schema version row plus `CREATE TABLE IF NOT
EXISTS` for subscriber rows. Cloudflare Durable Object migrations create or bind
the class; they do not replace application-level table migrations inside each
object instance.

### Server-Only Boundary

`defineLiveStream()` declarations are server-only. They may import server
runtime modules and must not be included in client bundles.

Void should enforce this boundary:

- client builds should fail if a client module imports `void/live`
- docs should recommend keeping browser helpers in separate client modules that
  use `void/live/client` or native `EventSource` plus the documented control
  protocol

This prevents server-only live declarations and dependencies from leaking into
frontend code.

### Naming And Collisions

Class and binding names should be stable across builds. The recommended default
class and binding names are:

```txt
className: VoidLiveStreamDurableObject
bindingName: VOID_LIVE
```

If those collide with user-provided bindings or classes, the compiler should
append a short deterministic hash. The manifest stores the final class and
binding names so deploy migration history remains stable.

Stream ids should also be stable across builds. Because core v1 does not scan a
special declaration directory, the id is provided explicitly in
`defineLiveStream({ id })`. Changing it creates a new stream namespace, but does
not require creating or deleting a Durable Object class.

## Userland Layers

The core primitive intentionally stops at topic fanout. Userland libraries can
own richer semantics by choosing topic strings and payload shapes:

- entity invalidation: `post:12`, `comment:2323`
- list or connection invalidation: `connection:posts:<stable-hash>`
- app-wide messages: `global:notifications`
- typed topic builders and payload validators
- live-query refetch policies
- normalized-cache updates
- reconnect recovery backed by application refetch endpoints, queues, or custom
  Durable Objects
- client state integrations for React, Vue, Svelte, Solid, or other frameworks

This boundary is important. `void/live` should make those systems production-safe
on Cloudflare by providing durable coordination and one multiplexed SSE
connection, but it should not define their data model.

## Fit With Void And Cloudflare

This design fits Void and Cloudflare if the implementation keeps the connection
and topic roles explicit.

What works well:

- A single generated Durable Object class and binding keeps deploy manifests and
  migration history small.
- One SSE connection per browser client avoids browser HTTP connection limits.
- Topic Durable Objects give deterministic ordering and localized fanout for a
  topic.
- Connection Durable Objects allow one client to subscribe to many topics
  without transferring the browser stream between topic instances.
- Publish does not self-fetch a public route. It uses generated bindings and
  Durable Object stubs, which works from request handlers, scheduled handlers,
  and queue consumers.
- Local dev can use the same Durable Object path through Miniflare/workerd.
- Hosted dispatch only needs the `text/event-stream` passthrough behavior from
  the `void/sse` RFC.

Constraints and risks:

- A single hot topic is still limited by one topic Durable Object instance in
  v1. This is acceptable for moderate fanout, but not for extremely large
  broadcast channels. V1 must enforce a conservative per-topic subscription cap
  instead of allowing unbounded fanout.
- Topic indexes are cached in Durable Object memory but backed by storage. If a
  topic object is evicted, active connection objects still exist. The RFC
  therefore requires durable subscriber index storage with timestamps, hydration
  on publish, and stale-row pruning. This adds storage writes on
  subscribe/unsubscribe and a read on cold publish, but it keeps routing correct
  across topic object restarts.
- Best-effort unregister can fail when a connection disappears. Topic objects
  must prune stale subscribers on delivery failure and may use alarms or TTLs.
- Cross-DO fanout adds internal requests from topic objects to connection
  objects. This is the right tradeoff for selective fanout, but the topic object
  must group matching subscriptions by connection instance, serialize
  publishes, dispatch each publish in bounded batches, enforce a delivery
  timeout, and tests should measure latency and cost against the configured
  subrequest budget.
- Native SSE is not hibernatable like WebSockets. Long-lived streams consume
  active request resources, so docs must position `void/ws` for very large
  connection sets or bidirectional workloads.
- Per-subscription replay is more complex than plain `Last-Event-ID` because a
  single SSE connection multiplexes many subscriptions. V1 should not implement
  or fake replay. Applications can carry opaque event ids in the JSON envelope
  and use them in userland refetch or custom replay systems outside the core
  live protocol.

Conclusion: this design makes sense as Void's v1 live primitive. It is a useful
foundation for normalized-cache and live-view systems because it gives one
client connection, dynamic server-authorized subscriptions, and topic-local
publish fanout without taking ownership of those higher-level semantics.

## Local Dev

Local dev must use the same Durable Object-backed path as production.

Requirements:

- `stream.connect(c)` opens a stream through the generated binding.
- `stream.control(c)` updates subscriptions through the generated binding.
- `stream.publish(...)` publishes through generated topic Durable Objects.
- tests should not rely on module-level shared state.

This parity is important because in-memory fanout can appear to work locally and
fail after deploy.

## Hosted Dispatch Behavior

`void/live` still returns an HTTP SSE response to the browser, so it depends on
the hosted streaming behavior specified in the `void/sse` RFC:

- no body reads
- no cache writes
- no ISR writes
- no asset fallback body probing
- per-response `text/event-stream` classification

This belongs in dispatch regardless of whether an app uses `void/sse` directly
or `void/live`.

## Documentation

Add docs covering:

- when to use plain `void/sse`
- when to use `void/live`
- one browser SSE connection plus POST control operations
- waiting for the SSE connection to open before sending control operations
- topic streams
- app-wide topics for broadcast-style updates
- dynamic subscribe and unsubscribe
- auth before `connect()`
- owner-key binding between `connect()` and `control()`
- owner key normalization and anonymous-control opt-in
- route-side custom auth context for `onSubscribe`
- authorization in `onSubscribe`
- publishing from routes, scheduled handlers, and queue consumers
- delivery semantics and replay limitations
- deployment-scoped live state and reconnect/refetch expectations
- production constraints around slow consumers, hot topics, and connection
  lifetime
- subrequest-budget-aware topic caps
- why `void/live` v1 omits native SSE `id` fields
- when to use `void/ws` instead of `void/live`

## Testing

Runtime tests:

- `connect()` returns a valid `text/event-stream` response.
- `control()` accepts batched subscribe and unsubscribe operations.
- `control()` returns the stable `accepted` response envelope and stable
  per-operation result/error codes.
- the client helper does not send control requests before the SSE connection is
  open.
- `control()` rejects missing, not-currently-open, closed, and owner-mismatched
  connection ids.
- connection validation and `onConnect` rejection return ordinary HTTP error
  responses before the SSE stream opens.
- built-in Void auth and custom `{ owner, user }` options produce the expected
  route-side hook context for `onSubscribe`.
- browser-supplied owner or user fields in the public control body are ignored or
  rejected and never reach hook context.
- topic validation and `onSubscribe` rejection return per-operation JSON
  errors without opening unauthorized subscriptions.
- v1 does not emit a core asynchronous subscription-error event after subscribe
  success.
- one SSE connection can hold multiple active topic subscriptions.
- `publish()` only delivers to subscriptions for the matching topic.
- if multiple matching subscriptions belong to the same connection, the topic
  Durable Object makes one delivery call to that connection instance.
- replacing a subscription id detaches the previous topic and prevents queued or
  stale rows from delivering under the reused id.
- a failed subscription replacement leaves the previous active subscription
  unchanged.
- unsubscribe stops future delivery.
- reconnect marks retained subscriptions inactive until they are resubmitted and
  authorized again.
- reconnect increments the connection generation, and stale topic rows do not
  receive events or count against topic subscription caps after pruning.
- disconnect removes the active SSE response and best-effort unregisters
  subscriptions.
- stale topic subscribers are pruned when delivery to a connection instance
  fails.
- topic subscription caps are enforced atomically by the topic Durable Object and
  reject new subscriptions without breaking existing subscribers.
- stream configuration that exceeds the effective subrequest budget is rejected
  or clamped before deploy/runtime use.
- slow consumers are closed without blocking other connections.
- delivery attempts that exceed the configured timeout are pruned or marked stale
  without blocking later publishes indefinitely.
- `publish()` resolves after bounded enqueue attempts and delivery timeouts, not
  after every client flushes.
- concurrent publishes to the same topic are delivered in topic-local order.
- `publish()` outside runtime env throws a clear error.
- `withEnv(env).publish(...)` works in tests and non-request entry points.
- publish rejects non-JSON-serializable payloads and invalid application event
  types.
- native SSE `id` fields are omitted by `void/live` v1.
- application-provided `eventId` is copied into the JSON envelope when present.
- `lastEventId` is accepted on subscribe operations but does not trigger core
  replay.

Compiler/deploy tests:

- apps with live streams generate one shared Durable Object class and binding.
- non-type server imports of `void/live` activate the shared Durable Object
  class and binding, while `void/live/client` imports do not.
- class and binding names are stable.
- user-provided stream ids, connection instance names, and topic instance names
  are stable.
- naming collisions are resolved deterministically.
- client bundles cannot import server-only `void/live`.
- live manifest validation rejects malformed entries.
- live manifests declare SQLite-backed Durable Object storage and emit
  `new_sqlite_classes` migrations for the generated class.
- live Durable Object instance schema initialization is idempotent across cold
  starts and redeploys.
- migration history is preserved across deploys.
- removing a live stream does not require deleting a Durable Object class.

End-to-end test:

- `GET /live` opens `stream.connect(c)`.
- `POST /live` subscribes one connection to two topics.
- `POST /publish` or a mutation calls `stream.publish(topic, payload)`.
- the client receives only events for subscribed topics.
- after `POST /live` unsubscribes one subscription, that topic no longer
  delivers.
- a second client subscribed to a different topic does not receive unrelated
  events.

## Implementation Plan

1. Implement and test `void/sse`.
2. Harden hosted dispatch passthrough for `text/event-stream`.
3. Add `void/live` runtime types for string topics, control requests, and
   client envelopes.
4. Implement the shared Durable Object with connection and topic instance roles.
5. Add owner-key binding, inactive-on-reconnect subscription state, topic
   subscription caps, connection generations, ordered publish queues, bounded
   fanout batching grouped by connection instance, delivery timeouts, and
   subrequest-budget validation.
6. Add `connect()`, `control()`, `publish()`, `withEnv()`, and
   `void/live/client`.
7. Add route-side hook context for built-in Void auth and explicit custom auth
   options.
8. Add generated shared Durable Object export and build/deploy detection for
   `void/live`.
9. Add package exports, platform manifest validation, SQLite-backed DO bindings,
   migration enrichment, and idempotent live DO schema initialization.
10. Add local dev parity.
11. Add docs and end-to-end examples.

## Decisions

- V1 should use one SSE connection per browser client plus POST control
  operations for dynamic subscriptions.
- `connect()` should require a client-generated `connectionId`. V1 should not
  support transient server-generated connection ids.
- Control operations should only be sent after the SSE connection has opened;
  missing or closed connection ids are rejected instead of queued indefinitely.
- Connection ids are bound to an internal owner key, and `control()` must reject
  owner mismatches.
- `onSubscribe` runs route-side in `control()` before Durable Object dispatch;
  browser control bodies cannot supply owner, user, or authorization context.
- Reconnect keeps optional metadata only as inactive state; subscriptions must
  be resubmitted and reauthorized before delivery resumes. Connection
  generations prevent stale topic rows from receiving events or consuming topic
  capacity after pruning.
- `connect({ initial })` should not ship in v1. The client helper should open
  the SSE connection and then send normal control subscriptions.
- Server-side selectivity is based on opaque topic strings, not client-side
  `EventSource` event listeners.
- Singleton-specific hubs should not ship in v1. App-wide updates should use an
  explicit topic such as `global:notifications`.
- The implementation should use connection Durable Object instances and topic
  Durable Object instances under one generated class and binding.
- V1 should enforce conservative per-topic subscription and per-control-request
  operation caps, clamp those caps to the effective subrequest budget, group
  matching subscriptions by connection instance, and call connection instances
  in bounded batches.
- Topic subscription caps are enforced atomically by the topic Durable Object.
- Topic Durable Objects should serialize publishes so bounded fanout batching
  does not break topic-local event ordering, but each publish has a delivery
  timeout so stale connection rows cannot block the topic indefinitely.
- The generated live Durable Object should be SQLite-backed, with manifest
  migrations using `new_sqlite_classes` and instance-local table initialization
  remaining idempotent.
- Durable replay should not ship in core v1 and should not be represented by a
  core config option. Application event ids and event types may live in the JSON
  envelope; `void/live` v1 should not emit native SSE `id` fields or arbitrary
  native SSE event names.

## Open Questions

1. Should the v1 client helper keep the SSE connection open briefly after the
   last subscription is removed to avoid reconnect churn during route
   transitions?
2. Should live streams support publishing from platform-owned workers, or only
   from code running inside the user's deployed app?
