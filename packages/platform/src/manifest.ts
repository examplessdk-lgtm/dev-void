import type { PlatformApplication } from './application.ts';

export const PLATFORM_DEPLOYMENT_SCHEMA_VERSION = 1 as const;

export type PlatformCapabilities = Readonly<{
  ai: boolean;
  customDomains: boolean;
  email: boolean;
  githubActions: boolean;
  githubOAuth: boolean;
  googleOAuth: boolean;
  managedBuilds: boolean;
  sandbox: boolean;
}>;

export type PlatformControlPlane = Readonly<{
  apiHostname: string | null;
  dashboardHostname: string | null;
  proxyHostname: string | null;
}>;

export type PlatformResourceNames = Readonly<{
  aiGateway: string;
  apiWorker: string;
  assetsBucket: string;
  cronQueue: string;
  dashboardWorker: string;
  dispatchNamespace: string;
  dispatchWorker: string;
  hyperdrive: string;
  isrCacheKv: string;
  legacyAssetsKv: string;
  logsDataset: string;
  proxyWorker: string;
  requestsDataset: string;
  routingKv: string;
  tailWorker: string;
  usageQueue: string;
}>;

export type PlatformDeploymentManifest = Readonly<{
  application: PlatformApplication;
  authentication: Readonly<{
    providers: ReadonlyArray<'github' | 'google'>;
  }>;
  capabilities: PlatformCapabilities;
  controlPlane: PlatformControlPlane;
  displayName: string;
  installationSlug: string;
  resources: PlatformResourceNames;
  schemaVersion: typeof PLATFORM_DEPLOYMENT_SCHEMA_VERSION | 2;
}>;

export type PlatformDeploymentManifestInput = Readonly<{
  application: Readonly<{
    baseDomain: string;
    dedicatedZone?: boolean;
    zoneName: string;
    workersDev?: PlatformApplication['workersDev'];
    zoneId?: string;
  }>;
  authentication?: Readonly<{
    providers?: ReadonlyArray<'github' | 'google'>;
  }>;
  capabilities?: Partial<PlatformCapabilities>;
  controlPlane?: Partial<PlatformControlPlane>;
  displayName: string;
  installationSlug: string;
  resources?: Partial<PlatformResourceNames>;
}>;

export type PlatformApplicationRoute = Readonly<{
  pattern: string;
  zoneName: string;
}>;

const CORE_CAPABILITIES: PlatformCapabilities = {
  ai: true,
  customDomains: false,
  email: false,
  githubActions: false,
  githubOAuth: true,
  googleOAuth: false,
  managedBuilds: false,
  sandbox: false,
};

const CONTROL_PLANE_DEFAULTS: PlatformControlPlane = {
  apiHostname: null,
  dashboardHostname: null,
  proxyHostname: null,
};

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

export function normalizeInstallationSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .replaceAll(/-{2,}/g, '-');
  if (!slug) {
    throw new Error('The installation name must contain a letter or number.');
  }
  if (slug.length > 40) {
    throw new Error('The installation name must be 40 characters or fewer after normalization.');
  }
  return slug;
}

export function normalizeApplicationDomain(value: string): string {
  let domain = value.trim().toLowerCase();
  if (domain.endsWith('.')) {
    domain = domain.slice(0, -1);
  }
  if (
    domain.length > 253 ||
    !domain.includes('.') ||
    domain.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new Error(`Invalid domain: ${JSON.stringify(value)}.`);
  }
  return domain;
}

export function createPlatformResourceNames(installationSlug: string): PlatformResourceNames {
  const slug = normalizeInstallationSlug(installationSlug);
  const prefix = `void-${slug}`;
  const datasetPrefix = prefix.replaceAll('-', '_');
  return {
    aiGateway: prefix,
    apiWorker: `${prefix}-api`,
    assetsBucket: `${prefix}-assets`,
    cronQueue: `${prefix}-cron-fires`,
    dashboardWorker: `${prefix}-dashboard`,
    dispatchNamespace: `${prefix}-users`,
    dispatchWorker: `${prefix}-dispatch`,
    hyperdrive: `${prefix}-database`,
    isrCacheKv: `${prefix}-isr-cache`,
    legacyAssetsKv: `${prefix}-legacy-assets`,
    logsDataset: `${datasetPrefix}_logs`,
    proxyWorker: `${prefix}-proxy`,
    requestsDataset: `${datasetPrefix}_requests`,
    routingKv: `${prefix}-routing`,
    tailWorker: `${prefix}-tail`,
    usageQueue: `${prefix}-usage-events`,
  };
}

export function createApplicationRoutes(
  application: PlatformDeploymentManifest['application'],
): ReadonlyArray<PlatformApplicationRoute> {
  if (!application.zoneName && application.workersDev) {
    if (application.dedicatedZone) {
      throw new Error('workers.dev cannot use a dedicated-zone catch-all.');
    }
    return [];
  }
  const baseDomain = normalizeApplicationDomain(application.baseDomain);
  const zoneName = normalizeApplicationDomain(application.zoneName);
  if (baseDomain !== zoneName && !baseDomain.endsWith(`.${zoneName}`)) {
    throw new Error(`Application domain ${baseDomain} is not inside zone ${zoneName}.`);
  }
  const routes: Array<PlatformApplicationRoute> = [
    { pattern: `*.${baseDomain}/*`, zoneName },
    { pattern: `*.${baseDomain}`, zoneName },
  ];
  if (application.dedicatedZone) {
    if (baseDomain !== zoneName) {
      throw new Error('A dedicated-zone catch-all requires the application domain to be the zone.');
    }
    routes.push({ pattern: '*/*', zoneName }, { pattern: '*', zoneName });
  }
  return routes;
}

export function createPlatformDeploymentManifest(
  input: PlatformDeploymentManifestInput,
): PlatformDeploymentManifest {
  const installationSlug = normalizeInstallationSlug(input.installationSlug);
  const baseDomain = normalizeApplicationDomain(input.application.baseDomain);
  const workersDev = input.application.workersDev;
  if (
    workersDev &&
    (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(workersDev.subdomain) ||
      !/^[a-z0-9][a-z0-9-]{0,80}$/.test(workersDev.installationId))
  ) {
    throw new Error('Invalid workers.dev installation identity.');
  }
  const zoneName =
    workersDev && input.application.zoneName === ''
      ? ''
      : normalizeApplicationDomain(input.application.zoneName);
  if (!zoneName && baseDomain !== `${workersDev!.subdomain}.workers.dev`) {
    throw new Error('workers.dev application domain must match its account subdomain.');
  }
  const resources = { ...createPlatformResourceNames(installationSlug), ...input.resources };
  const capabilities = { ...CORE_CAPABILITIES, ...input.capabilities };
  if (capabilities.managedBuilds && !capabilities.githubActions) {
    throw new Error('Managed builds require the GitHub Actions capability.');
  }
  const providers = input.authentication?.providers ?? ['github'];
  if (providers.length === 0) {
    throw new Error('At least one authentication provider is required.');
  }
  if (providers.includes('github') !== capabilities.githubOAuth) {
    throw new Error('The GitHub provider and githubOAuth capability must agree.');
  }
  if (providers.includes('google') !== capabilities.googleOAuth) {
    throw new Error('The Google provider and googleOAuth capability must agree.');
  }
  const manifest: PlatformDeploymentManifest = {
    application: {
      baseDomain,
      dedicatedZone: input.application.dedicatedZone ?? false,
      zoneName,
      ...(workersDev ? { workersDev: { ...workersDev } } : {}),
      ...(input.application.zoneId
        ? { zoneId: requiredString(input.application.zoneId, 'application.zoneId') }
        : {}),
    },
    authentication: { providers: [...providers] },
    capabilities,
    controlPlane: { ...CONTROL_PLANE_DEFAULTS, ...input.controlPlane },
    displayName: requiredString(input.displayName, 'displayName').trim(),
    installationSlug,
    resources,
    schemaVersion: workersDev ? 2 : PLATFORM_DEPLOYMENT_SCHEMA_VERSION,
  };
  createApplicationRoutes(manifest.application);
  for (const [key, value] of Object.entries(manifest.controlPlane)) {
    if (value !== null) {
      normalizeApplicationDomain(value);
    }
    if (value === '') {
      throw new Error(`controlPlane.${key} must be a hostname or null.`);
    }
  }
  for (const [key, value] of Object.entries(manifest.resources)) {
    requiredString(value, `resources.${key}`);
  }
  return manifest;
}

export function parsePlatformDeploymentManifest(value: unknown): PlatformDeploymentManifest {
  assertRecord(value, 'Platform deployment manifest');
  if (value.schemaVersion !== PLATFORM_DEPLOYMENT_SCHEMA_VERSION && value.schemaVersion !== 2) {
    throw new Error(
      `Unsupported platform deployment schema version: ${String(value.schemaVersion)}.`,
    );
  }
  const application = value.application;
  const authentication = value.authentication;
  const rawCapabilities = value.capabilities;
  const controlPlane = value.controlPlane;
  const rawResources = value.resources;
  assertRecord(application, 'application');
  let workersDev: PlatformApplication['workersDev'];
  if (value.schemaVersion === 2) {
    assertRecord(application.workersDev, 'application.workersDev');
    workersDev = {
      subdomain: requiredString(application.workersDev.subdomain, 'workersDev.subdomain'),
      installationId: requiredString(
        application.workersDev.installationId,
        'workersDev.installationId',
      ),
    };
  } else if (application.workersDev !== undefined) {
    throw new Error('workers.dev requires platform deployment schema version 2.');
  }
  assertRecord(rawCapabilities, 'capabilities');
  assertRecord(controlPlane, 'controlPlane');
  assertRecord(authentication, 'authentication');
  assertRecord(rawResources, 'resources');
  const capabilityKeys = Object.keys(CORE_CAPABILITIES) as Array<keyof PlatformCapabilities>;
  const capabilities: Partial<Record<keyof PlatformCapabilities, boolean>> = {};
  for (const key of capabilityKeys) {
    const entry = rawCapabilities[key];
    if (typeof entry !== 'boolean') {
      throw new Error(`capabilities.${key} must be a boolean.`);
    }
    capabilities[key] = entry;
  }
  const providers = authentication.providers;
  if (
    !Array.isArray(providers) ||
    providers.some((provider) => provider !== 'github' && provider !== 'google')
  ) {
    throw new Error('authentication.providers must contain only github or google.');
  }
  const resourceDefaults = createPlatformResourceNames(
    requiredString(value.installationSlug, 'installationSlug'),
  );
  const resources: Partial<Record<keyof PlatformResourceNames, string>> = {};
  for (const key of Object.keys(resourceDefaults) as Array<keyof PlatformResourceNames>) {
    resources[key] = requiredString(rawResources[key], `resources.${key}`);
  }
  const readHostname = (key: keyof PlatformControlPlane): string | null => {
    const hostname = controlPlane[key];
    return hostname === null ? null : requiredString(hostname, `controlPlane.${key}`);
  };
  return createPlatformDeploymentManifest({
    application: {
      baseDomain: requiredString(application.baseDomain, 'application.baseDomain'),
      dedicatedZone: application.dedicatedZone === true,
      zoneName:
        workersDev && application.zoneName === ''
          ? ''
          : requiredString(application.zoneName, 'application.zoneName'),
      ...(workersDev ? { workersDev } : {}),
      ...(typeof application.zoneId === 'string' ? { zoneId: application.zoneId } : {}),
    },
    authentication: { providers: providers as Array<'github' | 'google'> },
    capabilities,
    controlPlane: {
      apiHostname: readHostname('apiHostname'),
      dashboardHostname: readHostname('dashboardHostname'),
      proxyHostname: readHostname('proxyHostname'),
    },
    displayName: requiredString(value.displayName, 'displayName'),
    installationSlug: requiredString(value.installationSlug, 'installationSlug'),
    resources,
  });
}
