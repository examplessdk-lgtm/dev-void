import { readPlatformApplication, type PlatformApplication } from './application.ts';
import {
  parsePlatformLoginDescriptor,
  parsePlatformLoginId,
  type PlatformLoginDescriptor,
} from './authentication.ts';
import {
  normalizeApplicationDomain,
  normalizePlatformDashboardUrl,
  type PlatformCapabilities,
} from './manifest.ts';

export const PLATFORM_DISCOVERY_SCHEMA_VERSION = 1 as const;

export type PlatformAuthenticationDiscovery = Readonly<{
  methods: ReadonlyArray<PlatformLoginDescriptor>;
  protectedByAccess: boolean;
  setupPending?: boolean;
}>;

export type PlatformDiscoveryDocument = Readonly<{
  apiUrl: string;
  applicationDomain: string;
  applicationRouting?: PlatformApplication;
  authenticationProviders: ReadonlyArray<string>;
  authentication?: PlatformAuthenticationDiscovery;
  capabilities: PlatformCapabilities;
  displayName: string;
  dashboardUrl?: string;
  installationId: string | null;
  platformVersion: string;
  proxyUrl: string;
  schemaVersion: typeof PLATFORM_DISCOVERY_SCHEMA_VERSION | 2 | 3;
  usageProtocolVersion: 0 | 1 | 2;
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
  input: Omit<PlatformDiscoveryDocument, 'schemaVersion' | 'usageProtocolVersion'> & {
    usageProtocolVersion?: 0 | 1 | 2;
  },
): PlatformDiscoveryDocument {
  if (!input.displayName.trim()) {
    throw new Error('displayName must not be empty.');
  }
  if (!input.platformVersion.trim()) {
    throw new Error('platformVersion must not be empty.');
  }
  if (input.applicationRouting) {
    const application = readPlatformApplication({
      PLATFORM_APPLICATION: JSON.stringify(input.applicationRouting),
    });
    if (
      !application.workersDev ||
      application.baseDomain !== input.applicationDomain ||
      application.workersDev.installationId !== input.installationId
    ) {
      throw new Error(
        'Application routing must match the discovery domain and installation identity.',
      );
    }
  }
  if (
    input.usageProtocolVersion !== undefined &&
    input.usageProtocolVersion !== 0 &&
    input.usageProtocolVersion !== 1 &&
    input.usageProtocolVersion !== 2
  ) {
    throw new Error('usageProtocolVersion must be 0, 1, or 2.');
  }
  const authentication = input.authentication
    ? parseAuthentication(input.authentication)
    : undefined;
  if (
    !authentication &&
    input.authenticationProviders.some((provider) => provider !== 'github' && provider !== 'google')
  ) {
    throw new Error('Named login methods require authentication discovery descriptors.');
  }
  if (new Set(input.authenticationProviders).size !== input.authenticationProviders.length) {
    throw new Error('Authentication provider IDs must be unique.');
  }
  if (input.authenticationProviders.length === 0 && !authentication?.setupPending) {
    throw new Error('At least one authentication provider is required.');
  }
  if (
    authentication &&
    (authentication.methods.length !== input.authenticationProviders.length ||
      authentication.methods.some(
        (method, index) => method.id !== input.authenticationProviders[index],
      ))
  ) {
    throw new Error('Authentication method descriptors must match the advertised provider IDs.');
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
    ...(authentication ? { authentication } : {}),
    displayName: input.displayName.trim(),
    ...(input.dashboardUrl !== undefined
      ? { dashboardUrl: normalizePlatformDashboardUrl(input.dashboardUrl) }
      : {}),
    installationId: input.installationId?.trim() || null,
    platformVersion: input.platformVersion.trim(),
    proxyUrl: normalizeOrigin(input.proxyUrl, 'proxyUrl'),
    schemaVersion: authentication
      ? 3
      : input.applicationRouting?.workersDev
        ? 2
        : PLATFORM_DISCOVERY_SCHEMA_VERSION,
    usageProtocolVersion: input.usageProtocolVersion ?? 0,
  };
}

export function parsePlatformDiscoveryDocument(value: unknown): PlatformDiscoveryDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Platform discovery document must be an object.');
  }
  const document = value as Record<string, unknown>;
  if (
    document.schemaVersion !== PLATFORM_DISCOVERY_SCHEMA_VERSION &&
    document.schemaVersion !== 2 &&
    document.schemaVersion !== 3
  ) {
    throw new Error(
      `Unsupported platform discovery schema version: ${String(document.schemaVersion)}.`,
    );
  }
  const capabilities = document.capabilities;
  if (document.schemaVersion === 1 && document.applicationRouting !== undefined) {
    throw new Error('Application routing requires discovery schema version 2.');
  }
  if (document.schemaVersion === 2 && document.applicationRouting === undefined) {
    throw new Error('Discovery schema version 2 requires application routing.');
  }
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
    providers.some(
      (provider) =>
        typeof provider !== 'string' ||
        (document.schemaVersion !== 3 && provider !== 'github' && provider !== 'google'),
    )
  ) {
    throw new Error('authenticationProviders must contain only github or google.');
  }
  if (document.schemaVersion !== 3 && document.authentication !== undefined) {
    throw new Error('Configurable authentication requires discovery schema version 3.');
  }
  const authentication =
    document.schemaVersion === 3 ? parseAuthentication(document.authentication) : undefined;
  if (authentication) {
    providers.forEach(parsePlatformLoginId);
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
    ...(document.applicationRouting !== undefined
      ? {
          applicationRouting: readPlatformApplication({
            PLATFORM_APPLICATION: JSON.stringify(document.applicationRouting ?? null),
          }),
        }
      : {}),
    authenticationProviders: providers as Array<string>,
    ...(authentication ? { authentication } : {}),
    capabilities: parsedCapabilities,
    displayName: string('displayName'),
    ...(document.dashboardUrl !== undefined ? { dashboardUrl: string('dashboardUrl') } : {}),
    installationId: document.installationId === null ? null : string('installationId'),
    platformVersion: string('platformVersion'),
    proxyUrl,
    usageProtocolVersion: parseUsageProtocolVersion(document.usageProtocolVersion),
  });
}

function parseAuthentication(value: unknown): PlatformAuthenticationDiscovery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Authentication discovery must be an object.');
  }
  const authentication = value as Record<string, unknown>;
  if (
    !Array.isArray(authentication.methods) ||
    authentication.methods.length > 32 ||
    typeof authentication.protectedByAccess !== 'boolean' ||
    (authentication.setupPending !== undefined && typeof authentication.setupPending !== 'boolean')
  ) {
    throw new Error('Authentication discovery requires login methods and a protection flag.');
  }
  const methods = authentication.methods.map(parsePlatformLoginDescriptor);
  if (new Set(methods.map((method) => method.id)).size !== methods.length) {
    throw new Error('Authentication connection IDs must be unique.');
  }
  return {
    methods,
    protectedByAccess: authentication.protectedByAccess,
    ...(authentication.setupPending === true ? { setupPending: true } : {}),
  };
}

function parseUsageProtocolVersion(value: unknown): 0 | 1 | 2 {
  if (value === undefined || value === 0) {
    return 0;
  }
  if (value === 1) {
    return 1;
  }
  if (value === 2) {
    return 2;
  }
  throw new Error('usageProtocolVersion must be 0, 1, or 2.');
}
