import { DEFAULT_DASHBOARD_URL } from '../constants.ts';

export function isAllowedRedirect(
  url: string,
  dashboardUrl?: string,
  platformInstallationId?: string,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
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

export function isLocalhostRedirect(url: URL): boolean {
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}
