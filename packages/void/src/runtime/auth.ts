import { AsyncLocalStorage } from 'node:async_hooks';
import type { BetterAuthOptions, Session, User } from 'better-auth';
import type { Context, Env } from 'hono';
import { HTTPException } from 'hono/http-exception';

export type AuthUser = User;
export type AuthSession = Session;

export interface AuthState {
  session: AuthSession;
  user: AuthUser;
}

export interface VoidAuthConfigContext {
  defaults: BetterAuthOptions;
  env: Record<string, unknown>;
  dialect: 'sqlite' | 'postgresql';
  request: Request;
}

export type VoidAuthConfig =
  | BetterAuthOptions
  | ((ctx: VoidAuthConfigContext) => BetterAuthOptions);

/**
 * Shared AsyncLocalStorage that holds the authenticated Better Auth state for the
 * current request.
 *
 * Stored on `globalThis` under a `Symbol.for` key so duplicate module loads
 * (e.g. once by void's bundled runtime and once by Vite's SSR module runner
 * when user code imports from `void/auth`) share a single ALS instance. Without
 * this, the middleware writes to one instance and `getUser()` reads another,
 * always returning null.
 */
type AuthContextStore = { user: AuthUser | null; state: AuthState | null };
const AUTH_CONTEXT_SYMBOL: unique symbol = Symbol.for('void.authContext.v1');
type GlobalWithAuthContext = {
  [AUTH_CONTEXT_SYMBOL]?: AsyncLocalStorage<AuthContextStore>;
};
const globalWithAuthContext = globalThis as GlobalWithAuthContext;
export const authContext: AsyncLocalStorage<AuthContextStore> =
  globalWithAuthContext[AUTH_CONTEXT_SYMBOL] ??
  (globalWithAuthContext[AUTH_CONTEXT_SYMBOL] = new AsyncLocalStorage<AuthContextStore>());

export function defineAuth<T extends VoidAuthConfig>(config: T): T {
  return config;
}

export function getUser(): AuthUser | null {
  return authContext.getStore()?.user ?? null;
}

export function getSession(): AuthState | null {
  return authContext.getStore()?.state ?? null;
}

export function requireAuth<E extends Env & { Variables: { user: AuthUser | null } }>(
  c: Context<E>,
): AuthUser {
  const user = c.get('user');
  if (!user) {
    throw new HTTPException(401, { message: 'Unauthorized' });
  }
  return user;
}
