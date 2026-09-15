import { normalizeApplicationDomain, type PlatformCapabilities } from './manifest.ts';

export const PLATFORM_DISCOVERY_SCHEMA_VERSION = 1 as const;

export type PlatformDiscoveryDocument = Readonly<{
  apiUrl: string;
  applicationDomain: string;
  authenticationProviders: ReadonlyArray<'github' | 'google'>;
  capabilities: PlatformCapabilities;
  displayName: string;
  installationId: string | null;
  platformVersion: string;
  proxyUrl: string;
  schemaVersion: typeof PLATFORM_DISCOVERY_SCHEMA_VERSION;
}>;

function normalizeOrigin(value: string, name: 'apiUrl' | 'proxyUrl'): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
  const localHttp =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1');
  if ((!localHttp && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error(`${name} must be a credential-free HTTPS URL.`);
  }
  if ((url.pathname !== '' && url.pathname !== '/') || url.search || url.hash) {
    throw new Error(`${name} must be an origin without a path, query, or fragment.`);
  }
  return url.origin;
}

export function createPlatformDiscoveryDocument(
  input: Omit<PlatformDiscoveryDocument, 'schemaVersion'>,
): PlatformDiscoveryDocument {
  if (!input.displayName.trim()) {
    throw new Error('displayName must not be empty.');
  }
  if (!input.platformVersion.trim()) {
    throw new Error('platformVersion must not be empty.');
  }
  if (input.authenticationProviders.length === 0) {
    throw new Error('At least one authentication provider is required.');
  }
  if (
    input.authenticationProviders.includes('github') !== input.capabilities.githubOAuth ||
    input.authenticationProviders.includes('google') !== input.capabilities.googleOAuth
  ) {
    throw new Error('Authentication providers and capabilities must agree.');
  }
  return {
    ...input,
    apiUrl: normalizeOrigin(input.apiUrl, 'apiUrl'),
    applicationDomain: normalizeApplicationDomain(input.applicationDomain),
    authenticationProviders: [...input.authenticationProviders],
    displayName: input.displayName.trim(),
    installationId: input.installationId?.trim() || null,
    platformVersion: input.platformVersion.trim(),
    proxyUrl: normalizeOrigin(input.proxyUrl, 'proxyUrl'),
    schemaVersion: PLATFORM_DISCOVERY_SCHEMA_VERSION,
  };
}

export function parsePlatformDiscoveryDocument(value: unknown): PlatformDiscoveryDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Platform discovery document must be an object.');
  }
  const document = value as Record<string, unknown>;
  if (document.schemaVersion !== PLATFORM_DISCOVERY_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported platform discovery schema version: ${String(document.schemaVersion)}.`,
    );
  }
  const capabilities = document.capabilities;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    throw new Error('capabilities must be an object.');
  }
  const capabilityNames: Array<keyof PlatformCapabilities> = [
    'ai',
    'customDomains',
    'email',
    'githubActions',
    'githubOAuth',
    'googleOAuth',
    'managedBuilds',
    'sandbox',
  ];
  const parsedCapabilities = {} as Record<keyof PlatformCapabilities, boolean>;
  for (const name of capabilityNames) {
    const enabled = (capabilities as Record<string, unknown>)[name];
    if (typeof enabled !== 'boolean') {
      throw new Error(`capabilities.${name} must be a boolean.`);
    }
    parsedCapabilities[name] = enabled;
  }
  const providers = document.authenticationProviders;
  if (
    !Array.isArray(providers) ||
    providers.some((provider) => provider !== 'github' && provider !== 'google')
  ) {
    throw new Error('authenticationProviders must contain only github or google.');
  }
  const string = (name: string): string => {
    const entry = document[name];
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error(`${name} must be a non-empty string.`);
    }
    return entry;
  };
  const apiUrl = string('apiUrl');
  const proxyUrl =
    typeof document.proxyUrl === 'string' && document.proxyUrl.trim()
      ? document.proxyUrl
      : apiUrl === 'https://api.void.cloud'
        ? 'https://proxy.void.cloud'
        : apiUrl === 'https://api.staging.void.cloud'
          ? 'https://proxy.staging.void.cloud'
          : string('proxyUrl');
  return createPlatformDiscoveryDocument({
    apiUrl,
    applicationDomain: string('applicationDomain'),
    authenticationProviders: providers as Array<'github' | 'google'>,
    capabilities: parsedCapabilities,
    displayName: string('displayName'),
    installationId: document.installationId === null ? null : string('installationId'),
    platformVersion: string('platformVersion'),
    proxyUrl,
  });
}
