import type { RequestType } from './metering.ts';

/** True if the last path segment contains a `.` (has a file extension). */
export function hasExtension(pathname: string): boolean {
  return pathname.slice(pathname.lastIndexOf('/') + 1).includes('.');
}

/**
 * An `/api` route (worker-dynamic). Such a path must never enter the shared
 * page ISR cache — directly, or via a fallback that rewrites a page 404 into a
 * 200 from `/api/*`. A `/api` response is per-request dynamic (cookies, auth,
 * live data); caching it under a page URL would serve one caller's response to
 * everyone.
 */
export function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

/**
 * Classify a user-worker (dynamic) request for metering from its path and whether
 * the project is SSR. Returns 'api'/'ssr', or null to keep the caller's existing
 * default ('static'/'websocket'). Used on BOTH the success path and the dispatch
 * TIMEOUT path so timed-out /api and SSR requests are metered with the right type
 * instead of collapsing into the 'static' bucket.
 *
 * An SSR worker also serves the deploy's static files, so a path with a file
 * extension keeps the default unless `handledByApp` is true, meaning the caller
 * knows the app's own code answered. That needs the worker, not Cloudflare's
 * asset layer, to have answered the path, and then either the asset manifest
 * was read and does not list it (a route such as `routes/og.png.ts`), or the
 * worker returned a server error or ran past the dispatch budget. A successful
 * response with no manifest answer keeps the default.
 */
export function classifyDynamicRequestType(
  pathname: string,
  ssr: boolean | undefined,
  handledByApp = false,
): RequestType | null {
  if (isApiPath(pathname)) {
    return 'api';
  }
  if (ssr && (!hasExtension(pathname) || handledByApp)) {
    return 'ssr';
  }
  return null;
}
