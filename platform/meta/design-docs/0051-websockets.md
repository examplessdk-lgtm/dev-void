---
title: WebSocket Support
status: draft
created: 2026-03-05
---

# WebSocket Support

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

## Summary

Add first-class WebSocket support to Void, built on top of Cloudflare Durable Objects via `partyserver`, with a typed, framework-level API surface:

- file-based `.ws.ts` routes in `routes/`
- two server APIs: `defineRoom()` and `defineWebSocket()`
- ambient auth/session context across the WebSocket lifecycle
- typed messages in v1 via Standard Schema-compatible validators
- typed `connect()` client with auto-reconnect
- automatic Durable Object exports, bindings, and migration wiring at deploy

This feature is Cloudflare-only in v1. If a project uses `.ws.ts` routes with `target: "node" | "bun" | "deno"`, Void should fail the build with a clear error.

## Motivation

Real-time features are now table stakes for many apps: chat, collaborative editing, live dashboards, AI copilots, deployment logs, notifications, and multiplayer lobbies.

Today, Void has no first-class WebSocket story. Users would need to manually wire Durable Objects, upgrades, auth, and client reconnection. That is too far outside Void's normal DX bar.

WebSockets should feel like the rest of the framework:

- URL-addressable through file-based routing
- zero-config infrastructure on the hosted platform
- typed end to end
- auth-aware by default
- simple for the common case, with lower-level escape hatches later

## What This Enables

This design is intended to work well for the kinds of apps Durable Objects and the PartyKit ecosystem already fit well:

- chat rooms and presence
- shared cursors and collaborative rooms
- collaborative documents and whiteboards
- per-user notifications and activity streams
- AI/live token streaming UIs
- deployment logs and admin consoles
- lightweight multiplayer lobbies and turn-based coordination

These app shapes all share the same core pattern: a URL-scoped coordination point with shared state, ordered message handling, and server push.

## V1 Constraints and Non-Goals

This is not a Socket.IO clone, and it should not pretend to be one.

V1 explicitly does **not** include:

- Socket.IO-style `join()` / `leave()` room membership after connect
- global pubsub or cross-room fanout primitives
- generic Hono middleware execution before WebSocket upgrades
- Node/Bun/Deno target support
- framework-specific hooks/composables for Vue/React
- CRDT-specific collaboration helpers
- message metering or per-plan WS limits
- binary/raw frame APIs as the primary DX

Users should still be able to build sophisticated apps on top of this, but the primary model is:

- one WebSocket route
- one deterministic Durable Object instance identity per matched URL
- typed JSON messages
- ambient auth/session context

## Dependencies

- [`partyserver`](https://github.com/cloudflare/partykit/tree/main/packages/partyserver) — Durable Object + WebSocket lifecycle layer
- [`partysocket`](https://github.com/cloudflare/partykit/tree/main/packages/partysocket) — reconnecting client transport

Void owns:

- file-based routing
- API surface (`defineRoom` / `defineWebSocket`)
- typed message validation
- ambient auth/session context
- codegen and typed client surface
- Durable Object export generation
- deploy manifest / migration management

PartyServer owns:

- Durable Object internals
- hibernation behavior
- connection lifecycle plumbing
- connection indexing / room broadcast mechanics

## File Convention

```txt
routes/
  chat/[room].ws.ts
  docs/[docId].ws.ts
  notifications.ws.ts
  api/health.ts
```

- `.ws.ts` marks a WebSocket route
- each `.ws.ts` file compiles to one Durable Object class
- the matched URL params determine the Durable Object instance ID
- the file still lives under `routes/` because the endpoint is URL-addressable

Examples:

- `routes/chat/[room].ws.ts` -> one room instance per `room`
- `routes/docs/[docId].ws.ts` -> one coordination object per document
- `routes/notifications.ws.ts` -> one shared singleton instance

## Typed Message Model

Typed messages are required in v1.

Void should use the same Standard Schema-compatible model already used elsewhere in the framework. That keeps the feature aligned with `defineHandler.withValidator()` and avoids inventing a parallel type system.

The default payload model is a discriminated JSON event union:

```ts
type ClientEvent =
  { type: 'chat.message'; text: string } | { type: 'chat.typing'; active: boolean };

type ServerEvent =
  | { type: 'chat.message'; id: string; userId: string; text: string }
  | { type: 'presence.joined'; userId: string; name: string }
  | { type: 'presence.left'; userId: string };
```

V1 should validate and type these event objects directly. It should not make users hand-roll `JSON.parse()` or invent their own wire format for common JSON cases.

Raw/binary frames can be added later as an explicit escape hatch. They are not part of the core v1 design.

## Ambient Auth and Context

WebSocket routes should participate in Void auth/session resolution by default.

That means:

- `ctx.user` is available in `onBeforeConnect`, `onConnect`, `onMessage`, `onClose`, and `onRequest`
- cookie/session auth works the same way it does for HTTP routes
- users do not need to rebuild auth parsing inside each `.ws.ts` file

This does **not** mean arbitrary Hono middleware runs before the upgrade. Instead, Void should extract the framework's auth/session resolution into a shared internal helper used by both:

- the existing HTTP path
- the generated WebSocket upgrade path

This keeps auth ambient without over-promising full middleware reuse.

## API Layer 1: `defineRoom()`

`defineRoom()` is the high-level API for chat, collaboration, shared cursors, and multiplayer lobbies.

```ts
// routes/chat/[room].ws.ts
import * as v from 'valibot';
import { defineRoom } from 'void/ws';

const ClientEvent = v.variant('type', [
  v.object({
    type: v.literal('chat.message'),
    text: v.string(),
  }),
  v.object({
    type: v.literal('chat.typing'),
    active: v.boolean(),
  }),
]);

const ServerEvent = v.variant('type', [
  v.object({
    type: v.literal('chat.message'),
    id: v.string(),
    userId: v.string(),
    text: v.string(),
  }),
  v.object({
    type: v.literal('presence.joined'),
    userId: v.string(),
    name: v.string(),
  }),
  v.object({
    type: v.literal('presence.left'),
    userId: v.string(),
  }),
]);

export default defineRoom({
  messages: {
    client: ClientEvent,
    server: ServerEvent,
  },

  async onBeforeConnect(ctx) {
    if (!ctx.user) {
      return new Response('Unauthorized', { status: 401 });
    }
  },

  async onConnect(ctx) {
    ctx.room.broadcast({
      type: 'presence.joined',
      userId: ctx.user.id,
      name: ctx.user.name ?? ctx.user.email ?? 'anonymous',
    });
  },

  async onMessage(ctx, event) {
    if (event.type === 'chat.message') {
      ctx.room.broadcast(
        {
          type: 'chat.message',
          id: crypto.randomUUID(),
          userId: ctx.user!.id,
          text: event.text,
        },
        [ctx.connection.id],
      );
    }
  },

  async onClose(ctx) {
    if (!ctx.user) return;
    ctx.room.broadcast({
      type: 'presence.left',
      userId: ctx.user.id,
    });
  },

  async onRequest(ctx) {
    return Response.json({
      room: ctx.id,
      authenticated: Boolean(ctx.user),
      connections: [...ctx.room.getConnections()].length,
    });
  },
});
```

### Room Context

| Property/Method                       | Description                                                  |
| ------------------------------------- | ------------------------------------------------------------ |
| `ctx.id`                              | Durable Object instance ID derived from matched route params |
| `ctx.params`                          | Route params from the matched `.ws.ts` file                  |
| `ctx.user`                            | Authenticated user or `null`                                 |
| `ctx.request`                         | The upgrade request or HTTP request hitting the route        |
| `ctx.env`                             | Full Void bindings                                           |
| `ctx.storage`                         | Durable Object storage                                       |
| `ctx.room.broadcast(event, exclude?)` | Broadcast a typed server event                               |
| `ctx.room.getConnections()`           | Iterate active connections                                   |
| `ctx.room.getConnection(id)`          | Look up a connection by ID                                   |
| `ctx.connection.id`                   | Stable connection identifier                                 |
| `ctx.connection.send(event)`          | Send a typed server event to one client                      |
| `ctx.connection.close()`              | Close the socket                                             |

## API Layer 2: `defineWebSocket()`

`defineWebSocket()` is the lower-level API for per-user streams, notifications, AI token streams, and live dashboards.

```ts
// routes/notifications.ws.ts
import * as v from 'valibot';
import { defineWebSocket } from 'void/ws';

const ClientEvent = v.variant('type', [
  v.object({
    type: v.literal('notifications.ack'),
    id: v.string(),
  }),
]);

const ServerEvent = v.variant('type', [
  v.object({
    type: v.literal('notifications.item'),
    id: v.string(),
    title: v.string(),
  }),
  v.object({
    type: v.literal('notifications.error'),
    message: v.string(),
  }),
]);

export default defineWebSocket({
  messages: {
    client: ClientEvent,
    server: ServerEvent,
  },

  async onBeforeConnect(ctx) {
    if (!ctx.user) {
      return new Response('Unauthorized', { status: 401 });
    }
  },

  async onConnect(ctx) {
    ctx.socket.send({
      type: 'notifications.item',
      id: crypto.randomUUID(),
      title: `Connected as ${ctx.user!.id}`,
    });
  },

  async onMessage(ctx, event) {
    if (event.type === 'notifications.ack') {
      // app-defined acknowledgment behavior
    }
  },
});
```

This API omits room helpers but keeps the same typed message contract and ambient auth/session context.

## Client API

The client should be framework-agnostic in v1 and should mirror the typed `fetch()` philosophy.

```ts
import { connect } from 'void/ws';

const socket = connect('/chat/:room', {
  params: { room: 'general' },
});

socket.send({ type: 'chat.message', text: 'hello' });

socket.on('message', (event) => {
  if (event.type === 'chat.message') {
    console.log(event.text);
  }
});
```

`connect()` should provide:

- route-aware param typing
- typed `send()` based on the route's client schema
- typed incoming `message` events based on the route's server schema
- auto-reconnect
- buffering while reconnecting
- URL resolution relative to the current origin

Framework-specific hooks/composables remain follow-up work and should wrap this typed core client rather than inventing new semantics.

## Compilation

The Void compiler should:

1. scan `routes/` for `.ws.ts` files alongside HTTP routes
2. generate one Durable Object class per `.ws.ts` file
3. export those classes from the compiled worker entry alongside `fetch`, `scheduled`, and `queue`
4. generate a WebSocket route manifest for typed client/codegen
5. detect `Upgrade: websocket` in the worker `fetch` handler
6. match the upgrade request against the WebSocket route table
7. resolve route params and a deterministic Durable Object instance ID
8. resolve ambient auth/session context
9. run `onBeforeConnect`
10. forward the request to the matched Durable Object stub

Class names should be deterministic from the file path, e.g.:

- `routes/chat/[room].ws.ts` -> `ChatRoomWs`
- `routes/notifications.ws.ts` -> `NotificationsWs`

Durable Object instance naming should also be deterministic:

- no params -> `"default"`
- params -> serialized from the matched param values in route-param order

## Deploy Pipeline

The deploy manifest needs richer WebSocket metadata than a bare list of class names.

```ts
type DeployManifest = {
  version: number;
  bindings: {
    d1?: string[];
    kv?: string[];
    r2?: string[];
    ai?: boolean;
    hyperdrive?: string[];
  };
  websocket?: {
    routes: {
      pattern: string;
      filePath: string;
      className: string;
      mode: 'room' | 'socket';
      hasAuthGate: boolean;
    }[];
    classes: string[];
    migrations: {
      tag: string;
      newClasses?: string[];
      deletedClasses?: string[];
    }[];
  };
};
```

### Provisioning Flow

1. the compiler detects `.ws.ts` files and emits WebSocket manifest metadata
2. the API compares the current classes against the active deployment's classes
3. if the class set changed, the project's WebSocket migration counter increments and a new append-only migration entry is added
4. worker upload metadata includes:
   - Durable Object bindings
   - Durable Object migrations
   - exported Durable Object classes

### Migration Tracking

Durable Object migrations are append-only.

Each project tracks its current WebSocket migration version. A new migration tag is emitted only when the WebSocket class set changes.

Example:

```json
{
  "websocket": {
    "classes": ["ChatRoomWs", "NotificationsWs"],
    "migrations": [
      { "tag": "ws-v1", "newClasses": ["ChatRoomWs"] },
      { "tag": "ws-v2", "newClasses": ["NotificationsWs"] }
    ]
  }
}
```

## Dispatch and Metering

Workers for Platforms already supports WebSocket pass-through, so the dispatch worker does not need a new routing architecture.

The dispatch worker should:

- continue forwarding upgrade requests to user workers
- meter the upgrade request as a new request type: `websocket`
- not meter individual messages in v1

This keeps hosted usage accounting simple while avoiding premature message-level metering or plan enforcement.

## Responsibility Split

| Concern                                         | Owner       |
| ----------------------------------------------- | ----------- |
| File-based routing -> Durable Object generation | Void        |
| `defineRoom()` / `defineWebSocket()` API        | Void        |
| Typed message validation and inference          | Void        |
| Ambient auth/session context                    | Void        |
| URL -> Durable Object instance routing          | Void        |
| Typed client helper                             | Void        |
| Durable Object migration management at deploy   | Void        |
| Durable Object internals and hibernation        | PartyServer |
| Reconnecting client transport                   | PartySocket |

## Future Work

Follow-up work after v1:

- framework-specific Vue/React composables
- raw/binary frame escape hatches
- server-side helpers for cross-room or per-user fanout from non-WS routes
- optional presence helpers
- optional request/reply or RPC-style message conventions
- per-plan connection limits and message rate limiting
