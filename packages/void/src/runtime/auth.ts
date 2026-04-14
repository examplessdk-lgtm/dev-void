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
 */
export const authContext: AsyncLocalStorage<{ user: AuthUser | null; state: AuthState | null }> =
  new AsyncLocalStorage<{
    user: AuthUser | null;
    state: AuthState | null;
  }>();

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
