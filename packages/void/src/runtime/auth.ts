import type { Context, Env } from "hono";

import { HTTPException } from "hono/http-exception";
import { AsyncLocalStorage } from "node:async_hooks";

/** The authenticated user stored in the session and set on context by the auth middleware. */
export interface AuthUser {
  id: string;
  /** The provider that created this account (`"email"`, `"github"`, or `"google"`). */
  provider: string;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
}

/**
 * Shared AsyncLocalStorage that holds the authenticated user for the current request.
 * Populated by:
 * - The Hono session middleware (Void apps)
 * - The deploy wrapper (meta-framework apps)
 */
export const authContext: AsyncLocalStorage<{ user: AuthUser | null }> = new AsyncLocalStorage<{
  user: AuthUser | null;
}>();

/**
 * Get the authenticated user for the current request.
 *
 * Works in both Void apps and meta-framework apps (e.g. TanStack Start, Nuxt)
 * as long as auth is enabled. Returns `null` if no user is authenticated or
 * if called outside a request context.
 *
 * ```ts
 * import { getUser } from "void/auth";
 *
 * const user = getUser();
 * if (user) {
 *   console.log(user.email);
 * }
 * ```
 */
export function getUser(): AuthUser | null {
  return authContext.getStore()?.user ?? null;
}

/**
 * Extract the authenticated user from the request context, or throw a 401.
 *
 * Use this in route handlers to gate access to authenticated users:
 * ```ts
 * export default defineHandler((c) => {
 *   const user = requireAuth(c);
 *   return { user };
 * });
 * ```
 *
 * @throws {HTTPException} 401 if no user session is present.
 */
export function requireAuth<E extends Env & { Variables: { user: AuthUser | null } }>(
  c: Context<E>,
): AuthUser {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Unauthorized" });
  return user;
}
