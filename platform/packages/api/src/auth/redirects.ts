import { DEFAULT_DASHBOARD_URL } from '../constants.ts';

export function isAllowedRedirect(
  url: string,
  dashboardUrl?: string,
  platformInstallationId?: string,
  authorizationCallback?: string,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (isAuthorizationRedirect(url, authorizationCallback)) {
    return true;
  }

  // Localhost: allow any port, require exact hostname and http protocol
  if (isLocalhostRedirect(parsed)) {
    return true;
  }

  // Dashboard: compare exact origin (protocol + hostname + port)
  const origin = dashboardUrl ?? (platformInstallationId ? null : DEFAULT_DASHBOARD_URL);
  if (!origin) {
    return false;
  }
  try {
    return parsed.origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

/** Void's own OAuth browser callback. External apps never receive an account token. */
export function isAuthorizationRedirect(value: string, authenticationCallback?: string): boolean {
  if (!authenticationCallback) {
    return false;
  }
  try {
    const candidate = new URL(value);
    if (candidate.username || candidate.password || candidate.hash) {
      return false;
    }
    candidate.searchParams.delete('state');
    return candidate.href === new URL('/oauth/login/callback', authenticationCallback).href;
  } catch {
    return false;
  }
}

export function isLocalhostRedirect(url: URL): boolean {
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}
