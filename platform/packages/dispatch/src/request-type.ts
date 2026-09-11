import type { RequestType } from './metering.ts';

/** True if the last path segment contains a `.` (has a file extension). */
export function hasExtension(pathname: string): boolean {
  return pathname.slice(pathname.lastIndexOf('/') + 1).includes('.');
}

/**
 * Classify a user-worker (dynamic) request for metering from its path and whether
 * the project is SSR. Returns 'api'/'ssr', or null to keep the caller's existing
 * default ('static'/'websocket'). Used on BOTH the success path and the dispatch
 * TIMEOUT path so timed-out /api and SSR requests are metered with the right type
 * instead of collapsing into the 'static' bucket.
 */
export function classifyDynamicRequestType(
  pathname: string,
  ssr: boolean | undefined,
): RequestType | null {
  if (pathname.startsWith('/api/') || pathname === '/api') {
    return 'api';
  }
  if (ssr && !hasExtension(pathname)) {
    return 'ssr';
  }
  return null;
}
