import type { StandardSchemaV1 } from "../standard-schema";
import { authContext, type AuthState, type AuthUser } from "./auth";
import type { VoidAuthEnv, VoidAuthRuntimeOptions } from "./better-auth-shared";
import type { CloudEnv } from "./handler";
import type {
  AnyWebSocketDefinition,
  RoomController,
  RoomDefinition,
  SocketDefinition,
  WebSocketConnection,
} from "./ws";

export interface WebSocketRouteMeta {
  pattern: string;
  params: string[];
  className: string;
  bindingName: string;
}

export interface WebSocketDurableObjectInstance {
  fetch(request: Request): Promise<Response>;
  webSocketMessage(
    webSocket: WebSocket,
    message: string | ArrayBuffer | ArrayBufferView,
  ): Promise<void>;
  webSocketClose(
    webSocket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void>;
}

export interface WebSocketDurableObjectClass {
  new (state: DurableObjectState, env: Record<string, unknown>): WebSocketDurableObjectInstance;
}

type ResolveVoidAuthState = (
  request: Request,
  env: VoidAuthEnv,
  runtime: VoidAuthRuntimeOptions,
) => Promise<AuthState | null>;

interface StoredConnection {
  id: string;
  params: Record<string, string>;
  roomId: string;
  user: AuthUser | null;
  authState?: AuthState | null;
  state?: unknown;
}

function matchRoute(
  pattern: string,
  pathname: string,
): { matched: boolean; params: Record<string, string> } {
  const patternSegments = pattern.split("/").filter(Boolean);
  const pathSegments = pathname.split("/").filter(Boolean);
  const params: Record<string, string> = {};

  let i = 0;
  for (; i < patternSegments.length; i++) {
    const patternSegment = patternSegments[i]!;
    const pathSegment = pathSegments[i];

    if (patternSegment === "**") {
      return { matched: true, params };
    }

    if (patternSegment.startsWith("**:")) {
      params[patternSegment.slice(3)] = decodeURIComponent(pathSegments.slice(i).join("/"));
      return { matched: true, params };
    }

    if (pathSegment == null) {
      return { matched: false, params: {} };
    }

    if (patternSegment.startsWith(":")) {
      params[patternSegment.slice(1)] = decodeURIComponent(pathSegment);
      continue;
    }

    if (patternSegment !== pathSegment) {
      return { matched: false, params: {} };
    }
  }

  if (i !== pathSegments.length) {
    return { matched: false, params: {} };
  }

  return { matched: true, params };
}

function getRouteMatch(request: Request, route: WebSocketRouteMeta): Record<string, string> | null {
  const { pathname } = new URL(request.url);
  const match = matchRoute(route.pattern, pathname);
  return match.matched ? match.params : null;
}

export function buildWebSocketInstanceId(
  route: Pick<WebSocketRouteMeta, "params">,
  params: Record<string, string>,
): string {
  if (route.params.length === 0) return "default";
  return route.params.map((name) => `${name}=${params[name] ?? ""}`).join("&");
}

async function validateSchema(
  schema: StandardSchemaV1,
  value: unknown,
): Promise<
  { ok: true; value: unknown } | { ok: false; issues: readonly StandardSchemaV1.Issue[] }
> {
  const result = await schema["~standard"].validate(value);
  if (result.issues) {
    return { ok: false, issues: result.issues };
  }
  return { ok: true, value: result.value };
}

async function serializeServerEvent(schema: StandardSchemaV1, event: unknown): Promise<string> {
  const result = await validateSchema(schema, event);
  if (!result.ok) {
    throw new Error(result.issues.map((issue) => issue.message).join("; "));
  }
  return JSON.stringify(result.value);
}

function parseIncomingMessage(message: string | ArrayBuffer | ArrayBufferView): string {
  if (typeof message === "string") return message;
  if (message instanceof ArrayBuffer) return new TextDecoder().decode(message);
  return new TextDecoder().decode(
    message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength),
  );
}

function withAuthState<T>(state: AuthState | null, fn: () => Promise<T> | T): Promise<T> {
  return Promise.resolve(authContext.run({ user: state?.user ?? null, state }, fn));
}

function getStoredConnection(webSocket: WebSocket): StoredConnection {
  const stored = (
    webSocket as WebSocket & {
      deserializeAttachment?: () => StoredConnection | undefined;
    }
  ).deserializeAttachment?.();

  if (stored) {
    return {
      ...stored,
      authState: stored.authState ?? null,
    };
  }

  return {
    id: crypto.randomUUID(),
    params: {},
    roomId: "default",
    user: null,
    authState: null,
  };
}

function setStoredConnection(webSocket: WebSocket, data: StoredConnection): void {
  (
    webSocket as WebSocket & { serializeAttachment?: (value: StoredConnection) => void }
  ).serializeAttachment?.(data);
}

function createConnection<ServerEvent>(
  webSocket: WebSocket,
  serverSchema: StandardSchemaV1,
): WebSocketConnection<ServerEvent> {
  return {
    get id() {
      return getStoredConnection(webSocket).id;
    },
    get state() {
      return getStoredConnection(webSocket).state;
    },
    async send(event) {
      webSocket.send(await serializeServerEvent(serverSchema, event));
    },
    close(code, reason) {
      webSocket.close(code, reason);
    },
    setState(data) {
      const stored = getStoredConnection(webSocket);
      setStoredConnection(webSocket, { ...stored, state: data });
    },
  };
}

function createRoomController<ServerEvent>(
  state: DurableObjectState,
  serverSchema: StandardSchemaV1,
): RoomController<ServerEvent> {
  return {
    async broadcast(event, excludeIds = []) {
      const payload = await serializeServerEvent(serverSchema, event);
      for (const socket of state.getWebSockets()) {
        const stored = getStoredConnection(socket);
        if (excludeIds.includes(stored.id)) continue;
        socket.send(payload);
      }
    },
    getConnections() {
      return state
        .getWebSockets()
        .map((socket) => createConnection<ServerEvent>(socket, serverSchema));
    },
    getConnection(id) {
      const socket = state.getWebSockets().find((item) => getStoredConnection(item).id === id);
      return socket ? createConnection<ServerEvent>(socket, serverSchema) : undefined;
    },
  };
}

function createRoomContext<ServerEvent>(
  state: DurableObjectState,
  env: Record<string, unknown>,
  request: Request,
  webSocket: WebSocket,
  stored: StoredConnection,
  serverSchema: StandardSchemaV1,
) {
  return {
    id: stored.roomId,
    params: stored.params,
    user: stored.user,
    request,
    env: env as CloudEnv["Bindings"],
    storage: state.storage,
    room: createRoomController<ServerEvent>(state, serverSchema),
    connection: createConnection<ServerEvent>(webSocket, serverSchema),
  };
}

function createSocketContext<ServerEvent>(
  state: DurableObjectState,
  env: Record<string, unknown>,
  request: Request,
  webSocket: WebSocket,
  stored: StoredConnection,
  serverSchema: StandardSchemaV1,
) {
  return {
    id: stored.roomId,
    params: stored.params,
    user: stored.user,
    request,
    env: env as CloudEnv["Bindings"],
    storage: state.storage,
    socket: createConnection<ServerEvent>(webSocket, serverSchema),
  };
}

function assertDefinition(definition: AnyWebSocketDefinition): void {
  if (!definition?.messages?.client || !definition?.messages?.server) {
    throw new Error("WebSocket routes must define both messages.client and messages.server");
  }
}

export function createWebSocketDurableObject(
  definition: AnyWebSocketDefinition,
  route: WebSocketRouteMeta,
  authRuntime?: VoidAuthRuntimeOptions,
  resolveAuthState?: ResolveVoidAuthState,
): WebSocketDurableObjectClass {
  assertDefinition(definition);

  class VoidWebSocketDurableObject implements WebSocketDurableObjectInstance {
    constructor(
      public readonly state: DurableObjectState,
      public readonly env: Record<string, unknown>,
    ) {}

    async fetch(request: Request): Promise<Response> {
      const params = getRouteMatch(request, route) ?? {};
      const roomId = buildWebSocketInstanceId(route, params);
      const authState =
        authRuntime && resolveAuthState
          ? await resolveAuthState(request, this.env as VoidAuthEnv, authRuntime)
          : null;
      const user = authState?.user ?? null;
      const upgrade = request.headers.get("upgrade");

      if (upgrade?.toLowerCase() === "websocket") {
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        const stored: StoredConnection = {
          id: crypto.randomUUID(),
          params,
          roomId,
          user,
          authState,
        };
        setStoredConnection(server, stored);

        if (definition.__kind === "room") {
          const ctx = createRoomContext<any>(
            this.state,
            this.env,
            request,
            server,
            stored,
            definition.messages.server,
          );
          const decision = await withAuthState(authState, () =>
            (definition as RoomDefinition).onBeforeConnect?.(ctx),
          );
          if (decision instanceof Response) return decision;
        } else {
          const ctx = createSocketContext<any>(
            this.state,
            this.env,
            request,
            server,
            stored,
            definition.messages.server,
          );
          const decision = await withAuthState(authState, () =>
            (definition as SocketDefinition).onBeforeConnect?.(ctx),
          );
          if (decision instanceof Response) return decision;
        }

        this.state.acceptWebSocket(server);

        if (definition.__kind === "room") {
          const ctx = createRoomContext<any>(
            this.state,
            this.env,
            request,
            server,
            stored,
            definition.messages.server,
          );
          await withAuthState(authState, () => (definition as RoomDefinition).onConnect?.(ctx));
        } else {
          const ctx = createSocketContext<any>(
            this.state,
            this.env,
            request,
            server,
            stored,
            definition.messages.server,
          );
          await withAuthState(authState, () => (definition as SocketDefinition).onConnect?.(ctx));
        }

        return new Response(null, { status: 101, webSocket: client });
      }

      if (!definition.onRequest) {
        return new Response("Upgrade Required", { status: 426 });
      }

      const stored: StoredConnection = {
        id: crypto.randomUUID(),
        params,
        roomId,
        user,
        authState,
      };

      if (definition.__kind === "room") {
        const fakeSocket = new WebSocketPair()[1];
        const ctx = createRoomContext<any>(
          this.state,
          this.env,
          request,
          fakeSocket,
          stored,
          definition.messages.server,
        );
        return withAuthState(authState, () => (definition as RoomDefinition).onRequest!(ctx));
      }

      const fakeSocket = new WebSocketPair()[1];
      const ctx = createSocketContext<any>(
        this.state,
        this.env,
        request,
        fakeSocket,
        stored,
        definition.messages.server,
      );
      return withAuthState(authState, () => (definition as SocketDefinition).onRequest!(ctx));
    }

    async webSocketMessage(
      webSocket: WebSocket,
      message: string | ArrayBuffer | ArrayBufferView,
    ): Promise<void> {
      const stored = getStoredConnection(webSocket);
      const raw = parseIncomingMessage(message);

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        webSocket.close(1007, "Invalid JSON");
        return;
      }

      const result = await validateSchema(definition.messages.client, parsed);
      if (!result.ok) {
        webSocket.close(1007, "Invalid message");
        return;
      }

      const request = new Request(`https://void.local${route.pattern}`);

      if (definition.__kind === "room") {
        const ctx = createRoomContext<any>(
          this.state,
          this.env,
          request,
          webSocket,
          stored,
          definition.messages.server,
        );
        await withAuthState(stored.authState ?? null, () =>
          (definition as RoomDefinition).onMessage?.(ctx, result.value as never),
        );
      } else {
        const ctx = createSocketContext<any>(
          this.state,
          this.env,
          request,
          webSocket,
          stored,
          definition.messages.server,
        );
        await withAuthState(stored.authState ?? null, () =>
          (definition as SocketDefinition).onMessage?.(ctx, result.value as never),
        );
      }
    }

    async webSocketClose(
      webSocket: WebSocket,
      code: number,
      reason: string,
      wasClean: boolean,
    ): Promise<void> {
      const stored = getStoredConnection(webSocket);
      const request = new Request(`https://void.local${route.pattern}`);

      if (definition.__kind === "room") {
        const ctx = createRoomContext<any>(
          this.state,
          this.env,
          request,
          webSocket,
          stored,
          definition.messages.server,
        );
        await withAuthState(stored.authState ?? null, () =>
          (definition as RoomDefinition).onClose?.(ctx, { code, reason, wasClean }),
        );
      } else {
        const ctx = createSocketContext<any>(
          this.state,
          this.env,
          request,
          webSocket,
          stored,
          definition.messages.server,
        );
        await withAuthState(stored.authState ?? null, () =>
          (definition as SocketDefinition).onClose?.(ctx, { code, reason, wasClean }),
        );
      }
    }
  }

  return VoidWebSocketDurableObject;
}

function getStub(
  env: Record<string, unknown>,
  route: WebSocketRouteMeta,
  params: Record<string, string>,
) {
  const binding = env[route.bindingName] as DurableObjectNamespace | undefined;
  if (!binding) {
    throw new Error(`Missing Durable Object binding "${route.bindingName}"`);
  }
  const id = binding.idFromName(buildWebSocketInstanceId(route, params));
  return binding.get(id);
}

export async function handleWebSocketUpgrade(
  request: Request,
  env: Record<string, unknown>,
  routes: WebSocketRouteMeta[],
): Promise<Response | null> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return null;
  }

  for (const route of routes) {
    const params = getRouteMatch(request, route);
    if (!params) continue;
    return getStub(env, route, params).fetch(request);
  }

  return null;
}

export async function forwardWebSocketRequest(
  request: Request,
  env: Record<string, unknown>,
  route: WebSocketRouteMeta,
): Promise<Response> {
  const params = getRouteMatch(request, route) ?? {};
  return getStub(env, route, params).fetch(request);
}
