import type { ApiEnv } from './env.ts';

type PlatformIdentityEnv = Pick<
  ApiEnv['Bindings'],
  'AUTH_REDIRECT_URI' | 'PLATFORM_DISPLAY_NAME' | 'PLATFORM_INSTALLATION_ID' | 'PLATFORM_ENV'
>;

export function getPlatformDisplayName(env: PlatformIdentityEnv, requestUrl?: string): string {
  const name = env.PLATFORM_DISPLAY_NAME?.trim();
  if (name) {
    return name;
  }
  if (env.PLATFORM_INSTALLATION_ID) {
    return 'Void Platform';
  }
  const apiUrl = getPlatformApiUrl(env, requestUrl);
  return ['https://api.void.cloud', 'https://api.staging.void.cloud'].includes(apiUrl)
    ? 'Void Cloud'
    : 'Void Platform';
}

/** Use configured deployment identity or the actual request URL, never forwarded headers. */
export function getPlatformApiUrl(env: PlatformIdentityEnv, requestUrl?: string): string {
  const configuredUrl = env.AUTH_REDIRECT_URI || requestUrl;
  if (!configuredUrl && env.PLATFORM_INSTALLATION_ID) {
    throw new Error(
      'Set AUTH_REDIRECT_URI to the platform API OAuth callback URL before sending email.',
    );
  }
  const url = new URL(
    configuredUrl ||
      (env.PLATFORM_ENV === 'staging'
        ? 'https://api.staging.void.cloud'
        : 'https://api.void.cloud'),
  );
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('The platform API URL must be an HTTP(S) URL without credentials.');
  }
  return url.origin;
}

export function platformConnectCommand(apiUrl: string): string {
  // Quote even unusual but valid URL hostnames safely when the command is copied into a shell.
  return `void connect '${apiUrl.replaceAll("'", "'\\''")}'`;
}
