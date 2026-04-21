import type { Context, Env, MiddlewareHandler } from 'hono';
import type { RewriteDestination } from 'void/routes';
import type { HeadDescriptor } from '../pages/head';
import type { AuthSession, AuthUser } from './auth';
import { convertReturnValue } from './response';
import { runValidation, type ValidatorSlots, type HandlerInput } from './validator';

/**
 * Hono environment type for Void workers.
 *
 * Includes standard Cloudflare bindings plus request-scoped auth
 * variables populated by Better Auth middleware.
 */
export interface CloudContextVariables {
  user: AuthUser | null;
  session: AuthSession | null;
  headDefaults?: import('../pages/head').HeadDescriptor;
  [key: string]: unknown;
}

/**
 * Hono `Bindings` shape for Void workers.
 *
 * Augmented by the generated `.void/env.d.ts` so user-declared env keys
 * become typed on `c.env`. The index signature keeps untyped access
 * working for bindings that aren't in the schema (queues, custom
 * bindings, etc.).
 */
export interface CloudBindings {
  DB: D1Database;
  KV: KVNamespace;
  STORAGE: R2Bucket;
  AI: Ai;
  [key: string]: unknown;
}

declare module 'hono' {
  interface Context {
    /**
     * Rewrite the request to a different internal path without changing the browser URL.
     *
     * Must be called inside a `defineMiddleware` handler and the result must be returned:
     *
     * ```ts
     * export default defineMiddleware(async (c, next) => {
     *   if (!hasLocalePrefix(c.req.path)) {
     *     return c.rewrite(`/en${c.req.path}`);
     *   }
     *   return next();
     * });
     * ```
     *
     * The request is re-dispatched through the Hono router with the new pathname.
     * The re-dispatched request is tracked internally so that static routing rules
     * do not re-evaluate on it. Your middleware is responsible for its own loop
     * prevention (e.g., checking if the path already has a prefix).
     *
     * The `path` type is `RewriteDestination`, which is `keyof RouteMap | (string & {})`.
     * Known routes autocomplete, but any string is still accepted so dynamic paths
     * (e.g. `` `/users/${id}` ``) continue to work. When `.void/routes.d.ts` has not
     * been generated yet, `RouteMap` is empty and this is equivalent to `string`.
     */
    rewrite(path: RewriteDestination): Promise<Response>;
  }
}

export interface CloudEnv extends Env {
  Bindings: CloudBindings;
  Variables: CloudContextVariables;
}

/**
 * Hono {@link Context} pre-typed with {@link CloudEnv}.
 *
 * This is the type of the `c` parameter in route handlers and middleware
 * created with {@link defineHandler} and {@link defineMiddleware}.
 */
export type CloudContext = Context<CloudEnv>;

type HandlerFn = (c: CloudContext) => unknown | Promise<unknown>;
type MiddlewareFn = MiddlewareHandler<CloudEnv>;

/** Pre-rendered asset tags injected by the SSR build. */
export interface RenderAssetTags {
  /** CSS stylesheet links for `<head>`. */
  css: string;
  /** JS modulepreload links for `<head>` (only when page needs JS). */
  preloads: string;
  /** Script tags for `</body>` (only when page needs JS). */
  body: string;
}
type RenderFn = (c: CloudContext, assetTags: RenderAssetTags) => Response | Promise<Response>;
type JobController = ScheduledController;
type JobExecutionContext = ExecutionContext;
type ScheduledFn = (
  controller: JobController,
  env: CloudEnv['Bindings'],
  ctx: JobExecutionContext,
) => unknown | Promise<unknown>;

export type QueueRetryOptions = { delaySeconds?: number };

/** A single message in a queue batch. */
export type QueueMessage<T = unknown> = {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: T;
  readonly attempts: number;
  ack(): void;
  retry(options?: QueueRetryOptions): void;
};

/** A batch of queue messages delivered to a consumer handler. */
export type QueueBatch<T = unknown> = {
  readonly queue: string;
  readonly messages: Array<QueueMessage<T>>;
  ackAll(): void;
  retryAll(options?: QueueRetryOptions): void;
};

type QueueFn<T = unknown> = (
  batch: QueueBatch<T>,
  env: CloudEnv['Bindings'],
) => void | Promise<void>;

/**
 * A typed queue handler with a phantom type carrier for the payload type.
 * `__payload` exists at the type level only —
 * TypeScript's `typeof import(...)` reads it for codegen.
 */
export interface TypedQueueHandler<T = unknown> {
  (batch: QueueBatch<T>, env: CloudEnv['Bindings']): void | Promise<void>;
  readonly __payload: T;
}

/**
 * A typed handler with phantom type carriers for validators and return type.
 * `__validators` and `__output` exist at the type level only —
 * TypeScript's `typeof import(...)` reads them for codegen.
 */
export interface TypedHandler<V extends ValidatorSlots = {}, R = unknown> {
  (c: CloudContext): Promise<Response> | Response | unknown | Promise<unknown>;
  readonly __validators: V;
  readonly __output: R;
}

/**
 * Define a route handler, optionally composed with per-route middleware.
 *
 * Single argument: identity wrapper (backwards compatible).
 * Multiple arguments: middleware chain + final handler, composed at runtime.
 */
export function defineHandler<R>(
  handler: (c: CloudContext) => R | Response | Promise<R | Response>,
): TypedHandler<{}, Exclude<Awaited<R>, Response>>;
export function defineHandler(m1: MiddlewareFn, handler: HandlerFn): TypedHandler;
export function defineHandler(m1: MiddlewareFn, m2: MiddlewareFn, handler: HandlerFn): TypedHandler;
export function defineHandler(
  m1: MiddlewareFn,
  m2: MiddlewareFn,
  m3: MiddlewareFn,
  handler: HandlerFn,
): TypedHandler;
export function defineHandler(
  m1: MiddlewareFn,
  m2: MiddlewareFn,
  m3: MiddlewareFn,
  m4: MiddlewareFn,
  handler: HandlerFn,
): TypedHandler;
export function defineHandler(
  m1: MiddlewareFn,
  m2: MiddlewareFn,
  m3: MiddlewareFn,
  m4: MiddlewareFn,
  m5: MiddlewareFn,
  handler: HandlerFn,
): TypedHandler;
export function defineHandler(...args: Array<MiddlewareFn | HandlerFn>): TypedHandler {
  if (args.length === 1) {
    return args[0] as TypedHandler;
  }
  const middlewares = args.slice(0, -1) as Array<MiddlewareFn>;
  const handler = args[args.length - 1] as HandlerFn;

  return (async (c: CloudContext) => {
    let index = 0;
    const dispatch = async (): Promise<void> => {
      if (index < middlewares.length) {
        const mw = middlewares[index++];
        const res = await mw(c, dispatch);
        if (res instanceof Response) {
          c.res = res;
        }
      } else {
        c.res = convertReturnValue(await handler(c));
      }
    };
    await dispatch();
    return c.res;
  }) as TypedHandler;
}

/**
 * Create a handler with input validation using Standard Schema validators.
 *
 * ```ts
 * export const POST = defineHandler.withValidator({
 *   body: mySchema,
 * })((c, { body }) => {
 *   return { received: body };
 * });
 * ```
 */
export namespace defineHandler {
  export function withValidator<V extends ValidatorSlots>(
    validators: V,
  ): <R>(handler: (c: CloudContext, input: HandlerInput<V>) => R) => TypedHandler<V, R> {
    return <R>(handler: (c: CloudContext, input: HandlerInput<V>) => R): TypedHandler<V, R> => {
      return (async (c: CloudContext) => {
        const result = await runValidation(validators, c);
        if (!result.ok) {
          return result.response;
        }
        return convertReturnValue(await handler(c, result.input));
      }) as TypedHandler<V, R>;
    };
  }
}

/**
 * Identity function that provides type inference for middleware.
 * At runtime it simply returns the function passed to it.
 */
export function defineMiddleware(
  handler: MiddlewareHandler<CloudEnv>,
): MiddlewareHandler<CloudEnv> {
  return handler;
}

/**
 * Identity function that provides type inference for scheduled jobs.
 * At runtime it simply returns the function passed to it.
 */
export function defineScheduled(handler: ScheduledFn): ScheduledFn {
  return handler;
}

/**
 * Identity function that provides type inference for SSR render entry.
 * The second argument includes asset tags for client scripts/styles.
 */
export function defineRender(handler: RenderFn): RenderFn {
  return handler;
}

/**
 * Identity function that provides type inference for page `head()` exports.
 * At runtime it simply returns the function passed to it.
 */
export function defineHead<P = Record<string, unknown>>(
  handler: (c: CloudContext, props: P) => HeadDescriptor | undefined,
): (c: CloudContext, props: P) => HeadDescriptor | undefined {
  return handler;
}

/**
 * Identity function that provides type inference for queue consumers.
 * At runtime it simply returns the function passed to it.
 */
export function defineQueue<T = unknown>(handler: QueueFn<T>): TypedQueueHandler<T> {
  return handler as TypedQueueHandler<T>;
}

export type { ValidatorSlots, HandlerInput } from './validator';
export { ValidationError } from '../pages/validation-error';
export { defer } from '../pages/defer';
export type { Deferred, InferProps } from '../pages/defer';
