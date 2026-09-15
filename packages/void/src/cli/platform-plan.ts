import { createHash } from 'node:crypto';
import {
  createPlatformDeploymentManifest,
  createApplicationRoutes,
  createPlatformResourceOwnershipMarker,
  createPlatformResourceNames,
  normalizeInstallationSlug,
  parsePlatformInstallationManifest,
  parsePlatformResourceOwnershipMarker,
  PLATFORM_REMOTE_INSTALLATION_MANIFEST_KEY,
  PLATFORM_R2_OWNERSHIP_MARKER_KEY,
  type InstallationResourceKind,
  type PlatformDeploymentManifest,
  type PlatformInstallationManifest,
} from '@void/platform';
import type {
  CloudflareAccount,
  CloudflareDnsRecord,
  CloudflareNamedResource,
  CloudflareZone,
  PlatformCloudflareClient,
} from './platform-cloudflare.ts';

export type PlatformInstallPlanAction = Readonly<{
  action: 'adopt' | 'create' | 'reuse' | 'update';
  id: string | null;
  key: string;
  kind: InstallationResourceKind;
  name: string;
  reason: string;
}>;

export type PlatformInstallPlan = Readonly<{
  account: CloudflareAccount;
  actions: ReadonlyArray<PlatformInstallPlanAction>;
  apiUrl: string;
  deployment: PlatformDeploymentManifest;
  installationId: string;
  proxyUrl: string;
  workersSubdomain: string;
  zone: CloudflareZone | null;
}>;

export type PlatformInstallPlanInput = Readonly<{
  accountId: string;
  applicationDomain: string;
  controlPlaneDomain: string;
  dedicatedZone: boolean;
  displayName: string;
  installationSlug: string;
  zoneName: string;
}>;

type PlanningClient = Pick<
  PlatformCloudflareClient,
  | 'findZone'
  | 'findZoneForHostname'
  | 'getKvValue'
  | 'getR2Object'
  | 'getWorkerPlainTextBindings'
  | 'getWorkersSubdomain'
  | 'listAiGateways'
  | 'listAccounts'
  | 'listDispatchNamespaces'
  | 'listDnsRecords'
  | 'listHyperdriveConfigs'
  | 'listKvNamespaces'
  | 'listQueues'
  | 'listR2Buckets'
  | 'listWorkerNames'
  | 'listWorkerDomains'
  | 'listWorkerRoutes'
  | 'verifyToken'
>;

export async function createPlatformInstallPlan(
  client: PlanningClient,
  input: PlatformInstallPlanInput,
  existing: PlatformInstallationManifest | null,
  options?: {
    authoritativeProvisionIntents?: boolean;
    provisioningSuffix?: string;
    repairMissing?: boolean;
  },
): Promise<PlatformInstallPlan> {
  await client.verifyToken();
  const accounts = await client.listAccounts();
  const account = resolveAccount(accounts, input.accountId);
  if (existing && existing.account.id !== account.id) {
    throw new Error(
      `platform: Refusing to resume installation ${existing.id} in a different Cloudflare account.`,
    );
  }
  const installationSlug = normalizeInstallationSlug(input.installationSlug);
  const installationId =
    existing?.id ??
    `${installationSlug}-${createHash('sha256')
      .update(
        JSON.stringify({
          accountId: account.id,
          applicationDomain: input.applicationDomain,
          controlPlaneDomain: input.controlPlaneDomain,
          installationSlug,
          zoneName: input.zoneName,
        }),
      )
      .digest('hex')
      .slice(0, 12)}`;
  const deployment = createPlatformDeploymentManifest({
    application: {
      baseDomain: input.applicationDomain,
      dedicatedZone: input.dedicatedZone,
      zoneName: input.zoneName,
    },
    controlPlane: {
      apiHostname: input.controlPlaneDomain || null,
      dashboardHostname: null,
      proxyHostname: null,
    },
    displayName: input.displayName,
    installationSlug,
    resources:
      existing?.deployment.resources ??
      createPlatformResourceNames(
        resourceSlugForInstallation(installationSlug, installationId, options?.provisioningSuffix),
      ),
  });
  if (existing && JSON.stringify(existing.deployment) !== JSON.stringify(deployment)) {
    throw new Error(
      `platform: --resume inputs do not match installation ${existing.id}. Use its recorded configuration.`,
    );
  }

  const names = deployment.resources;
  const wildcardHostname = `*.${deployment.application.baseDomain}`;
  const [
    workersSubdomain,
    zone,
    aiGateways,
    routingKv,
    isrKv,
    legacyKv,
    r2Buckets,
    usageQueues,
    cronQueues,
    dispatchNamespaces,
    hyperdrives,
    workers,
  ] = await Promise.all([
    client.getWorkersSubdomain(account.id),
    client.findZone(account.id, deployment.application.zoneName),
    client.listAiGateways(account.id),
    client.listKvNamespaces(account.id, names.routingKv),
    client.listKvNamespaces(account.id, names.isrCacheKv),
    client.listKvNamespaces(account.id, names.legacyAssetsKv),
    client.listR2Buckets(account.id),
    client.listQueues(account.id, names.usageQueue),
    client.listQueues(account.id, names.cronQueue),
    client.listDispatchNamespaces(account.id),
    client.listHyperdriveConfigs(account.id),
    client.listWorkerNames(account.id),
  ]);
  const dnsRecords = zone ? await client.listDnsRecords(zone.id, wildcardHostname) : [];
  const remoteOwnership = existing
    ? await readRemoteOwnership(client, account.id, routingKv, existing)
    : null;
  const intentProofs = new Set<string>();
  const ambiguousResources = new Set<string>();
  if (existing) {
    const bucket = r2Buckets.find((resource) => resource.name === names.assetsBucket);
    const recordedBucket = existing.resources.find(
      (resource) =>
        resource.key === 'assets-bucket' &&
        resource.kind === 'r2-bucket' &&
        resource.ownership === 'created' &&
        resource.state === 'ready',
    );
    if (bucket && recordedBucket?.id === bucket.id && recordedBucket.name === bucket.name) {
      const marker = await client.getR2Object(
        account.id,
        bucket.name,
        PLATFORM_R2_OWNERSHIP_MARKER_KEY,
      );
      if (
        !matchesResourceMarker(marker, existing, 'assets-bucket', 'r2-bucket', bucket) ||
        !matchesRecordedR2Fingerprint(recordedBucket.configHash, bucket)
      ) {
        ambiguousResources.add('assets-bucket');
      }
    }
    if (
      bucket &&
      hasUnrecordedProvisionIntent(existing, 'assets-bucket', 'r2-bucket', bucket.name)
    ) {
      const marker = await client.getR2Object(
        account.id,
        bucket.name,
        PLATFORM_R2_OWNERSHIP_MARKER_KEY,
      );
      if (matchesResourceMarker(marker, existing, 'assets-bucket', 'r2-bucket', bucket)) {
        intentProofs.add('assets-bucket');
      }
    }
    for (const [key, name] of [
      ['api-worker', names.apiWorker],
      ['proxy-worker', names.proxyWorker],
      ['tail-worker', names.tailWorker],
      ['dispatch-worker', names.dispatchWorker],
    ] as const) {
      if (workers.includes(name) && hasUnrecordedProvisionIntent(existing, key, 'worker', name)) {
        const bindings = await client.getWorkerPlainTextBindings(account.id, name);
        if (
          matchesResourceMarker(bindings.PLATFORM_OWNERSHIP_MARKER, existing, key, 'worker', {
            id: name,
            name,
          })
        ) {
          intentProofs.add(key);
        }
      }
    }
  }
  if (zone) {
    const expectedPatterns = new Set(
      createApplicationRoutes(deployment.application).map((route) => route.pattern),
    );
    const expectedWorker = deployment.resources.dispatchWorker;
    const ownedWorker =
      intentProofs.has('dispatch-worker') ||
      existing?.resources.some(
        (resource) =>
          resource.key === 'dispatch-worker' &&
          resource.kind === 'worker' &&
          resource.name === expectedWorker &&
          resource.state === 'ready',
      );
    const conflicts = (await client.listWorkerRoutes(zone.id)).filter(
      (route) =>
        expectedPatterns.has(route.pattern) && (route.script !== expectedWorker || !ownedWorker),
    );
    if (conflicts.length > 0) {
      const conflict = conflicts[0]!;
      throw new Error(
        `platform: Application route ${JSON.stringify(conflict.pattern)} is already assigned to ${JSON.stringify(conflict.script ?? 'no Worker')}. Choose another application domain.`,
      );
    }
  }
  if (deployment.controlPlane.apiHostname) {
    const apiHostname = deployment.controlPlane.apiHostname;
    const [workerDomains, controlPlaneZone] = await Promise.all([
      client.listWorkerDomains(account.id),
      client.findZoneForHostname(account.id, apiHostname),
    ]);
    const matchingDomain = workerDomains.find((domain) => domain.hostname === apiHostname);
    const expectedWorker = deployment.resources.apiWorker;
    if (matchingDomain && matchingDomain.service !== expectedWorker) {
      throw new Error(
        `platform: Custom API hostname ${JSON.stringify(apiHostname)} is already assigned to Worker ${JSON.stringify(matchingDomain.service)}. Choose another hostname.`,
      );
    }
    const records = controlPlaneZone
      ? await client.listDnsRecords(controlPlaneZone.id, apiHostname)
      : [];
    const ownedApiWorker =
      intentProofs.has('api-worker') ||
      existing?.resources.some(
        (resource) =>
          resource.key === 'api-worker' &&
          resource.kind === 'worker' &&
          resource.name === expectedWorker &&
          resource.state === 'ready',
      );
    if (records.length > 0 && (!matchingDomain || !ownedApiWorker)) {
      throw new Error(
        `platform: Custom API hostname ${JSON.stringify(apiHostname)} already has a DNS record that installation would replace. Choose another hostname or remove the record explicitly.`,
      );
    }
  }
  const actions: Array<PlatformInstallPlanAction> = [];
  const recordedZone = existing?.resources.find((resource) => resource.key === 'zone');
  const remotelyOwnedZone = remoteOwnership?.resources.some(
    (resource) => resource.key === 'zone' && resource.id === zone?.id,
  );
  const repairCreatedZone =
    options?.repairMissing && recordedZone?.ownership === 'created' && !zone;
  if (
    recordedZone &&
    !repairCreatedZone &&
    (!zone || recordedZone.id !== zone.id || recordedZone.kind !== 'zone')
  ) {
    throw new Error(
      `platform: Recorded zone ${recordedZone.name} (${recordedZone.id}) no longer matches the Cloudflare account.`,
    );
  }
  actions.push({
    action: repairCreatedZone
      ? 'create'
      : recordedZone || (zone && remotelyOwnedZone)
        ? 'reuse'
        : zone
          ? 'adopt'
          : 'create',
    id: zone?.id ?? null,
    key: 'zone',
    kind: 'zone',
    name: deployment.application.zoneName,
    reason: repairCreatedZone
      ? 'Recreate the missing installer-owned zone.'
      : recordedZone || remotelyOwnedZone
        ? 'Reuse the recorded zone.'
        : zone
          ? 'Use the existing zone without taking ownership.'
          : 'Create the requested zone.',
  });
  addDnsPlan(actions, existing, wildcardHostname, dnsRecords, options);
  addNamedPlan(
    actions,
    existing,
    'ai-gateway',
    'ai-gateway',
    names.aiGateway,
    aiGateways.filter((resource) => resource.id === names.aiGateway),
    'reuse',
    options,
    remoteOwnership,
    intentProofs,
  );
  addNamedPlan(
    actions,
    existing,
    'routing-kv',
    'kv-namespace',
    names.routingKv,
    routingKv,
    'reuse',
    options,
    remoteOwnership,
    intentProofs,
  );
  addNamedPlan(
    actions,
    existing,
    'isr-cache-kv',
    'kv-namespace',
    names.isrCacheKv,
    isrKv,
    'reuse',
    options,
    remoteOwnership,
  );
  addNamedPlan(
    actions,
    existing,
    'legacy-assets-kv',
    'kv-namespace',
    names.legacyAssetsKv,
    legacyKv,
    'reuse',
    options,
    remoteOwnership,
  );
  addNamedPlan(
    actions,
    existing,
    'assets-bucket',
    'r2-bucket',
    names.assetsBucket,
    r2Buckets.filter((resource) => resource.name === names.assetsBucket),
    'reuse',
    options,
    remoteOwnership,
    intentProofs,
    ambiguousResources,
  );
  addNamedPlan(
    actions,
    existing,
    'usage-queue',
    'queue',
    names.usageQueue,
    usageQueues,
    'reuse',
    options,
    remoteOwnership,
  );
  addNamedPlan(
    actions,
    existing,
    'cron-queue',
    'queue',
    names.cronQueue,
    cronQueues,
    'reuse',
    options,
    remoteOwnership,
  );
  addNamedPlan(
    actions,
    existing,
    'dispatch-namespace',
    'dispatch-namespace',
    names.dispatchNamespace,
    dispatchNamespaces.filter((resource) => resource.name === names.dispatchNamespace),
    'reuse',
    options,
    remoteOwnership,
  );
  addNamedPlan(
    actions,
    existing,
    'hyperdrive',
    'hyperdrive',
    names.hyperdrive,
    hyperdrives.filter((resource) => resource.name === names.hyperdrive),
    'reuse',
    options,
    remoteOwnership,
  );
  for (const [key, name] of [
    ['api-worker', names.apiWorker],
    ['proxy-worker', names.proxyWorker],
    ['tail-worker', names.tailWorker],
    ['dispatch-worker', names.dispatchWorker],
  ] as const) {
    const matches = workers.includes(name) ? [{ id: name, name }] : [];
    addNamedPlan(
      actions,
      existing,
      key,
      'worker',
      name,
      matches,
      'update',
      options,
      remoteOwnership,
      intentProofs,
    );
  }
  const resolvedResources = { ...deployment.resources };
  for (const action of actions) {
    const resourceKey = RESOURCE_NAME_KEY_BY_ACTION[action.key];
    if (resourceKey && action.name !== resolvedResources[resourceKey]) {
      resolvedResources[resourceKey] = action.name;
    }
  }
  const resolvedDeployment = createPlatformDeploymentManifest({
    ...deployment,
    resources: resolvedResources,
  });
  const apiUrl = resolvedDeployment.controlPlane.apiHostname
    ? `https://${deployment.controlPlane.apiHostname}`
    : `https://${resolvedDeployment.resources.apiWorker}.${workersSubdomain}.workers.dev`;
  const proxyUrl = resolvedDeployment.controlPlane.proxyHostname
    ? `https://${deployment.controlPlane.proxyHostname}`
    : `https://${resolvedDeployment.resources.proxyWorker}.${workersSubdomain}.workers.dev`;
  return {
    account,
    actions,
    apiUrl,
    deployment: resolvedDeployment,
    installationId,
    proxyUrl,
    workersSubdomain,
    zone,
  };
}

export async function revalidatePlatformInstallAction(
  client: PlanningClient,
  original: PlatformInstallPlan,
  manifest: PlatformInstallationManifest,
  action: PlatformInstallPlanAction,
  options?: { authoritativeProvisionIntents?: boolean; repairMissing?: boolean },
): Promise<void> {
  const deployment = original.deployment;
  const refreshed = await createPlatformInstallPlan(
    client,
    {
      accountId: original.account.id,
      applicationDomain: deployment.application.baseDomain,
      controlPlaneDomain: deployment.controlPlane.apiHostname ?? '',
      dedicatedZone: deployment.application.dedicatedZone,
      displayName: deployment.displayName,
      installationSlug: deployment.installationSlug,
      zoneName: deployment.application.zoneName,
    },
    manifest,
    options,
  );
  const current = refreshed.actions.find((entry) => entry.key === action.key);
  if (
    !current ||
    current.kind !== action.kind ||
    current.name !== action.name ||
    current.action !== action.action
  ) {
    throw new Error(
      `platform: Cloudflare changed after the installation plan was approved for ${action.kind} ${JSON.stringify(action.name)}. Review a new plan before retrying.`,
    );
  }
  if (action.kind === 'worker' && action.action === 'update') {
    const bindings = await client.getWorkerPlainTextBindings(original.account.id, action.name);
    if (
      !matchesResourceMarker(bindings.PLATFORM_OWNERSHIP_MARKER, manifest, action.key, 'worker', {
        id: action.name,
        name: action.name,
      })
    ) {
      throw new Error(
        `platform: Cloudflare Worker ${JSON.stringify(action.name)} no longer has this installation's ownership marker. Review a new plan before retrying.`,
      );
    }
  }
}

function resourceSlugForInstallation(
  installationSlug: string,
  installationId: string,
  provisioningSuffix?: string,
): string {
  const suffix = provisioningSuffix ?? installationId.slice(installationSlug.length + 1);
  if (!/^(?:[a-f0-9]{12}|[a-f0-9]{32})$/.test(suffix)) {
    // Existing schema-v1 installations used the human-readable slug directly.
    return installationSlug;
  }
  // Keep every generated resource within Cloudflare's 63-character product-name
  // ceiling even with the new 128-bit suffix and the longest (`-usage-events`) role.
  const readablePrefix = installationSlug
    .slice(0, suffix.length === 32 ? 12 : 26)
    .replace(/-+$/, '');
  return `${readablePrefix}-${suffix}`;
}

function resourceSlugForManifest(manifest: PlatformInstallationManifest): string {
  const apiWorker = manifest.deployment.resources.apiWorker;
  if (!apiWorker.startsWith('void-') || !apiWorker.endsWith('-api')) {
    return manifest.deployment.installationSlug;
  }
  const resourceSlug = apiWorker.slice('void-'.length, -'-api'.length);
  const suffix = resourceSlug.slice(resourceSlug.lastIndexOf('-') + 1);
  if (!/^(?:[a-f0-9]{12}|[a-f0-9]{32})$/.test(suffix)) {
    return manifest.deployment.installationSlug;
  }
  return resourceSlug;
}

function addDnsPlan(
  actions: Array<PlatformInstallPlanAction>,
  existing: PlatformInstallationManifest | null,
  name: string,
  records: ReadonlyArray<CloudflareDnsRecord>,
  options?: { authoritativeProvisionIntents?: boolean; repairMissing?: boolean },
): void {
  const compatible = records.filter((record) => record.proxied);
  if (records.some((record) => !record.proxied)) {
    throw new Error(
      `platform: DNS name ${JSON.stringify(name)} contains an unproxied record. Proxy every record at this wildcard name through Cloudflare or choose another application domain.`,
    );
  }
  const recorded = existing?.resources.find((resource) => resource.key === 'application-dns');
  const remote = recorded
    ? compatible.find((record) => record.id === recorded.id)
    : compatible.sort((left, right) => left.id.localeCompare(right.id))[0];
  if (recorded) {
    if (remote && recorded.id === remote.id && recorded.kind === 'dns-record') {
      actions.push({
        action: 'reuse',
        id: remote.id,
        key: 'application-dns',
        kind: 'dns-record',
        name,
        reason: 'Reuse the recorded wildcard application DNS record.',
      });
      return;
    }
    if (!remote && options?.repairMissing && recorded.ownership === 'created') {
      actions.push({
        action: 'create',
        id: null,
        key: 'application-dns',
        kind: 'dns-record',
        name,
        reason: 'Recreate the missing installer-owned wildcard application DNS record.',
      });
      return;
    }
    throw new Error(
      `platform: Recorded DNS record ${JSON.stringify(recorded.name)} (${recorded.id}) no longer matches the Cloudflare zone.`,
    );
  }
  actions.push({
    action: remote ? 'adopt' : 'create',
    id: remote?.id ?? null,
    key: 'application-dns',
    kind: 'dns-record',
    name,
    reason: remote
      ? 'Use the existing compatible wildcard DNS record without taking ownership.'
      : 'Create an installer-owned proxied wildcard DNS record for application traffic.',
  });
}

function resolveAccount(
  accounts: ReadonlyArray<CloudflareAccount>,
  selector: string,
): CloudflareAccount {
  const matches = selector
    ? accounts.filter(
        (account) =>
          account.id === selector || account.name.toLowerCase() === selector.toLowerCase(),
      )
    : accounts;
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `platform: Cloudflare account ${JSON.stringify(selector)} is not available to this token.`
        : 'platform: Select a Cloudflare account with --account <id>.',
    );
  }
  return matches[0]!;
}

function addNamedPlan(
  actions: Array<PlatformInstallPlanAction>,
  existing: PlatformInstallationManifest | null,
  key: string,
  kind: InstallationResourceKind,
  name: string,
  matches: ReadonlyArray<CloudflareNamedResource>,
  existingAction: 'reuse' | 'update' = 'reuse',
  options?: { authoritativeProvisionIntents?: boolean; repairMissing?: boolean },
  remoteOwnership?: PlatformInstallationManifest | null,
  intentProofs: ReadonlySet<string> = new Set(),
  ambiguousResources: ReadonlySet<string> = new Set(),
): void {
  if (matches.length > 1) {
    throw new Error(`platform: More than one ${kind} named ${JSON.stringify(name)} exists.`);
  }
  const remote = matches[0];
  const recorded = existing?.resources.find((resource) => resource.key === key);
  if (remote) {
    if (existing && ambiguousResources.has(key)) {
      actions.push({
        action: 'create',
        id: null,
        key,
        kind,
        name: interruptedProvisionRetryName(existing, key, kind, name),
        reason:
          'Retain the ambiguously owned resource and create a fresh installer-scoped replacement.',
      });
      return;
    }
    const remotelyOwned = remoteOwnership?.resources.some(
      (resource) =>
        resource.key === key &&
        resource.kind === kind &&
        resource.id === remote.id &&
        resource.name === name &&
        resource.ownership === 'created',
    );
    const markedProvision =
      existing !== null &&
      isUniqueProvisionAttempt(existing, key, kind, name) &&
      hasUnrecordedProvisionIntent(existing, key, kind, name) &&
      intentProofs.has(key);
    const ambiguousProvision =
      existing !== null &&
      options?.authoritativeProvisionIntents === true &&
      isUniqueProvisionAttempt(existing, key, kind, name) &&
      hasAmbiguousProvisionIntent(existing, key, kind, remote.id, name);
    if (
      (!recorded || recorded.id !== remote.id || recorded.kind !== kind) &&
      !remotelyOwned &&
      !markedProvision &&
      !ambiguousProvision
    ) {
      throw new Error(
        `platform: ${kind} ${JSON.stringify(name)} already exists but is not owned by this installation. Choose another installation name.`,
      );
    }
    if (ambiguousProvision && !markedProvision && !remotelyOwned) {
      actions.push({
        action: 'create',
        id: null,
        key,
        kind,
        name: interruptedProvisionRetryName(existing, key, kind, name),
        reason:
          'Leave the ambiguous same-name resource untouched and create a fresh installer-scoped replacement.',
      });
      return;
    }
    actions.push({
      action: existingAction,
      id: remote.id,
      key,
      kind,
      name,
      reason: markedProvision
        ? 'Recover the uniquely named resource from an interrupted provisioning attempt.'
        : existingAction === 'update'
          ? 'Deploy the current platform version.'
          : 'Reuse the recorded resource.',
    });
    return;
  }
  if (recorded && recorded.state === 'ready') {
    if (options?.repairMissing && recorded.ownership === 'created') {
      actions.push({
        action: 'create',
        id: null,
        key,
        kind,
        name,
        reason: `Recreate the missing installer-owned ${kind}.`,
      });
      return;
    }
    if (options?.repairMissing && recorded.ownership !== 'created') {
      throw new Error(
        `platform: Recorded ${recorded.ownership} ${kind} ${JSON.stringify(name)} (${recorded.id}) is missing. Repair will not recreate a resource the installer does not own.`,
      );
    }
    throw new Error(
      `platform: Recorded ${kind} ${JSON.stringify(name)} (${recorded.id}) is missing. Run \`void platform repair ${existing!.id}\` to reconcile it.`,
    );
  }
  actions.push({
    action: 'create',
    id: null,
    key,
    kind,
    name,
    reason: `Create an installer-owned ${kind}.`,
  });
}

function hasUnrecordedProvisionIntent(
  manifest: PlatformInstallationManifest,
  key: string,
  kind: InstallationResourceKind,
  name: string,
): boolean {
  return (
    !manifest.resources.some((resource) => resource.key === key && resource.state === 'ready') &&
    manifest.steps.some(
      (step) =>
        isProvisionIntentStep(step.key, key) &&
        step.resultHash === platformProvisionIntentHash(manifest, key, kind, name),
    )
  );
}

function hasAmbiguousProvisionIntent(
  manifest: PlatformInstallationManifest,
  key: string,
  kind: InstallationResourceKind,
  remoteId: string,
  name: string,
): boolean {
  const recorded = manifest.resources.find((resource) => resource.key === key);
  if (recorded?.id === remoteId && recorded.kind === kind && recorded.name === name) {
    return false;
  }
  return manifest.steps.some(
    (step) =>
      isProvisionIntentStep(step.key, key) &&
      step.resultHash ===
        platformProvisionIntentHash(manifest, key, kind, name, recorded?.id ?? null),
  );
}

function isProvisionIntentStep(stepKey: string, resourceKey: string): boolean {
  return (
    stepKey === `provision-intent:${resourceKey}` ||
    stepKey.startsWith(`provision-intent:${resourceKey}:`)
  );
}

function interruptedProvisionRetryName(
  manifest: PlatformInstallationManifest,
  key: string,
  kind: InstallationResourceKind,
  name: string,
): string {
  const suffix = `-retry-${createHash('sha256')
    .update(JSON.stringify({ key, kind, name, ownershipNonce: manifest.ownershipNonce }))
    .digest('hex')
    .slice(0, 32)}`;
  return `${name.slice(0, 63 - suffix.length).replace(/-+$/, '')}${suffix}`;
}

function matchesRecordedR2Fingerprint(
  configHash: string,
  resource: CloudflareNamedResource,
): boolean {
  if (!resource.fingerprint) {
    return false;
  }
  const liveHash = createHash('sha256')
    .update(
      JSON.stringify({
        fingerprint: resource.fingerprint,
        kind: 'r2-bucket',
        name: resource.name,
      }),
    )
    .digest('hex');
  const legacyHash = createHash('sha256')
    .update(JSON.stringify({ kind: 'r2-bucket', name: resource.name }))
    .digest('hex');
  return configHash === liveHash || configHash === legacyHash;
}

function matchesResourceMarker(
  value: string | null | undefined,
  manifest: PlatformInstallationManifest,
  key: string,
  kind: InstallationResourceKind,
  resource: CloudflareNamedResource,
): boolean {
  if (!value) {
    return false;
  }
  try {
    const actual = parsePlatformResourceOwnershipMarker(JSON.parse(value) as unknown);
    const expected = createPlatformResourceOwnershipMarker({
      accountId: manifest.account.id,
      installationId: manifest.id,
      ownershipNonce: manifest.ownershipNonce,
      resourceId: resource.id,
      resourceKey: key,
      resourceKind: kind,
      resourceName: resource.name,
    });
    return JSON.stringify(actual) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

function isUniqueProvisionAttempt(
  manifest: PlatformInstallationManifest,
  key: string,
  kind: InstallationResourceKind,
  name: string,
): boolean {
  const resourceSlug = resourceSlugForManifest(manifest);
  if (resourceSlug === manifest.deployment.installationSlug) {
    return false;
  }
  const expectedNames = createPlatformResourceNames(resourceSlug);
  const resourceKey = RESOURCE_NAME_KEY_BY_ACTION[key];
  if (!resourceKey) {
    return false;
  }
  const expectedName = expectedNames[resourceKey];
  const uniquePrefix = expectedName.slice(0, expectedName.lastIndexOf('-') + 1);
  return (
    manifest.deployment.resources[resourceKey] === name &&
    (name === expectedName || name.startsWith(uniquePrefix)) &&
    kind !== 'zone' &&
    kind !== 'dns-record'
  );
}

const RESOURCE_NAME_KEY_BY_ACTION: Readonly<
  Record<string, keyof PlatformDeploymentManifest['resources']>
> = {
  'ai-gateway': 'aiGateway',
  'api-worker': 'apiWorker',
  'assets-bucket': 'assetsBucket',
  'cron-queue': 'cronQueue',
  'dispatch-namespace': 'dispatchNamespace',
  'dispatch-worker': 'dispatchWorker',
  hyperdrive: 'hyperdrive',
  'isr-cache-kv': 'isrCacheKv',
  'legacy-assets-kv': 'legacyAssetsKv',
  'proxy-worker': 'proxyWorker',
  'routing-kv': 'routingKv',
  'tail-worker': 'tailWorker',
  'usage-queue': 'usageQueue',
};

export function platformProvisionIntentHash(
  manifest: Pick<PlatformInstallationManifest, 'ownershipNonce'>,
  key: string,
  kind: InstallationResourceKind,
  name: string,
  previousResourceId: string | null = null,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        key,
        kind,
        name,
        ownershipNonce: manifest.ownershipNonce,
        ...(previousResourceId ? { previousResourceId } : {}),
      }),
    )
    .digest('hex');
}

export function platformAdoptionIntentHash(
  manifest: Pick<PlatformInstallationManifest, 'ownershipNonce'>,
  key: string,
  kind: InstallationResourceKind,
  id: string,
  name: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ id, key, kind, name, ownershipNonce: manifest.ownershipNonce }))
    .digest('hex');
}

async function readRemoteOwnership(
  client: PlanningClient,
  accountId: string,
  routingNamespaces: ReadonlyArray<CloudflareNamedResource>,
  existing: PlatformInstallationManifest,
): Promise<PlatformInstallationManifest | null> {
  for (const namespace of routingNamespaces) {
    const value = await client.getKvValue(
      accountId,
      namespace.id,
      PLATFORM_REMOTE_INSTALLATION_MANIFEST_KEY,
    );
    if (value === null) {
      continue;
    }
    let remote: PlatformInstallationManifest;
    try {
      remote = parsePlatformInstallationManifest(JSON.parse(value) as unknown);
    } catch {
      throw new Error(
        `platform: Routing namespace ${JSON.stringify(namespace.name)} contains invalid ownership metadata.`,
      );
    }
    const routing = remote.resources.find((resource) => resource.key === 'routing-kv');
    if (
      remote.id === existing.id &&
      remote.ownershipNonce === existing.ownershipNonce &&
      remote.account.id === accountId &&
      routing?.id === namespace.id &&
      routing.name === namespace.name &&
      routing.ownership === 'created'
    ) {
      return remote;
    }
  }
  return null;
}

export function formatPlatformInstallPlan(plan: PlatformInstallPlan): string {
  const lines = [
    `${plan.deployment.displayName} in ${plan.account.name} (${plan.account.id})`,
    `Applications: *.${plan.deployment.application.baseDomain}`,
    `Control plane: ${plan.apiUrl}`,
    `Resource proxy: ${plan.proxyUrl}`,
    '',
  ];
  for (const action of plan.actions) {
    lines.push(`${action.action.padEnd(6)} ${action.kind.padEnd(19)} ${action.name}`);
  }
  return lines.join('\n');
}
