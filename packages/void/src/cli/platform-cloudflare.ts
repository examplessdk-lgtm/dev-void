import { createHash, randomUUID } from 'node:crypto';
import { resolvePinnedApiBaseUrl } from './provision.ts';

type CloudflareEnvelope<T> = Readonly<{
  errors?: ReadonlyArray<{ code?: number; message?: string }>;
  result?: T;
  result_info?: {
    cursor?: string;
    page?: number;
    per_page?: number;
    total_pages?: number;
  };
  success?: boolean;
}>;

export class PlatformCloudflareApiError extends Error {
  readonly status: number;
  readonly requestPath?: string;

  constructor(message: string, status: number, requestPath?: string) {
    super(message);
    this.name = 'PlatformCloudflareApiError';
    this.status = status;
    this.requestPath = requestPath;
  }
}

export class PlatformWorkerCustomDomainsChangedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PlatformWorkerCustomDomainsChangedError';
  }
}

export class PlatformWorkerRoutesChangedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PlatformWorkerRoutesChangedError';
  }
}

export type CloudflareAccount = Readonly<{ id: string; name: string }>;
export type CloudflareNamedResource = Readonly<{
  fingerprint?: string;
  id: string;
  name: string;
}>;
export type CloudflareHyperdriveOrigin = Readonly<{
  database: string;
  host: string;
  port: number;
  scheme: 'postgresql';
  user: string | null;
}>;
export type CloudflareHyperdriveConfig = CloudflareNamedResource &
  Readonly<{ origin: CloudflareHyperdriveOrigin; cachingDisabled?: boolean }>;
export type CloudflareDnsRecord = CloudflareNamedResource &
  Readonly<{
    content: string;
    proxied: boolean;
    type: string;
  }>;
export type CloudflareZone = Readonly<{
  id: string;
  name: string;
  nameServers: ReadonlyArray<string>;
  status: string;
}>;
export type CloudflareWorkerDomain = Readonly<{
  hostname: string;
  id: string;
  service: string;
  zoneName?: string;
}>;
export type CloudflareWorkerCustomDomainOrigin = Readonly<{
  enabled?: boolean;
  hostname: string;
  previewsEnabled?: boolean;
  zoneId?: string;
  zoneName?: string;
}>;
export type CloudflareWorkerRoute = Readonly<{
  id: string;
  pattern: string;
  script: string | null;
}>;
export type CloudflareWorkerServiceRoute = Readonly<{
  pattern: string;
  zoneName: string;
}>;
export type PlatformManagedWorkerTraffic = Readonly<{
  customDomains: ReadonlyArray<Readonly<{ hostname: string; service: string }>>;
  routes: ReadonlyArray<Readonly<{ pattern: string; script: string }>>;
}>;
export type PlatformTrackedWorkerTraffic = Readonly<{
  customDomains: ReadonlyArray<CloudflareWorkerDomain>;
  routes: ReadonlyArray<Readonly<{ id: string; pattern: string; script: string }>>;
}>;

export type PlatformRuntimeTokenPreflightClient = Pick<
  PlatformCloudflareClient,
  'listHyperdriveConfigs' | 'request'
>;

export async function verifyPlatformRuntimeTokenPermissions(
  client: PlatformRuntimeTokenPreflightClient,
  input: {
    accountId: string;
    applicationDomain: string;
    customDomains: boolean;
    zoneId: string | null;
  },
): Promise<void> {
  try {
    await client.listHyperdriveConfigs(input.accountId);
  } catch (error) {
    throw runtimeTokenPreflightError('Account → Hyperdrive → Write', error);
  }

  if (!input.zoneId) {
    return;
  }

  const probeUrl = `https://${input.applicationDomain}/.well-known/void/runtime-token-preflight-${randomUUID()}`;
  try {
    await client.request(`/zones/${encodeURIComponent(input.zoneId)}/purge_cache`, {
      body: JSON.stringify({ files: [probeUrl] }),
      method: 'POST',
    });
  } catch (error) {
    throw runtimeTokenPreflightError('Zone → Cache Purge → Purge', error);
  }

  if (input.customDomains) {
    try {
      await client.request(
        `/zones/${encodeURIComponent(input.zoneId)}/custom_hostnames?per_page=1`,
      );
    } catch (error) {
      throw runtimeTokenPreflightError('Zone → SSL and Certificates → Edit', error);
    }
  }
}

function runtimeTokenPreflightError(permission: string, cause: unknown): Error {
  const status = cause instanceof PlatformCloudflareApiError ? cause.status : null;
  const message =
    status === 401 || status === 403
      ? `Cloudflare denied the runtime-token check (HTTP ${status}). Check that the token is valid, scoped to this account, and includes ${permission}.`
      : status === 429
        ? `Cloudflare rate-limited the runtime-token check for ${permission} (HTTP 429). Retry shortly; this does not mean the token is missing a permission.`
        : `Could not complete the runtime-token check for ${permission}${status === null ? '' : ` (Cloudflare HTTP ${status})`}. Retry the check; this failure does not establish that a permission is missing.`;
  return new Error(`platform: ${message}`, { cause });
}

export class PlatformCloudflareClient {
  readonly apiBaseUrl: string;
  readonly #fetcher: typeof fetch;
  readonly #token: string;
  readonly #aiGatewayClient?: PlatformCloudflareClient;

  constructor(
    token: string,
    options?: { apiBase?: string; fetcher?: typeof fetch; aiGatewayToken?: string },
  ) {
    if (!token) {
      throw new Error(
        'platform: CLOUDFLARE_API_TOKEN is required. The installed control plane also uses this scoped token to provision app resources.',
      );
    }
    this.#token = token;
    this.apiBaseUrl = (options?.apiBase ?? resolvePinnedApiBaseUrl()).replace(/\/+$/, '');
    this.#fetcher = options?.fetcher ?? fetch;
    if (options?.aiGatewayToken) {
      this.#aiGatewayClient = new PlatformCloudflareClient(options.aiGatewayToken, {
        apiBase: this.apiBaseUrl,
        fetcher: this.#fetcher,
      });
    }
  }

  /** Keep operator auth for infrastructure; use the existing runtime credential only for AI Gateway. */
  withAiGatewayToken(token: string): PlatformCloudflareClient {
    return new PlatformCloudflareClient(this.#token, {
      apiBase: this.apiBaseUrl,
      fetcher: this.#fetcher,
      aiGatewayToken: token,
    });
  }

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    return (await this.#requestEnvelope<T>(path, init)).result;
  }

  async #requestEnvelope<T>(
    path: string,
    init?: RequestInit,
  ): Promise<{ result: T; resultInfo: CloudflareEnvelope<T>['result_info'] }> {
    const response = await this.#fetcher(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.#token}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
      signal: init?.signal ?? AbortSignal.timeout(30_000),
      redirect: 'manual',
    });
    let envelope: CloudflareEnvelope<T>;
    try {
      envelope = (await response.json()) as CloudflareEnvelope<T>;
    } catch {
      throw new PlatformCloudflareApiError(
        `Cloudflare returned a non-JSON response (HTTP ${response.status}).`,
        response.status,
        path.split('?')[0],
      );
    }
    if (!response.ok || envelope.success !== true || envelope.result === undefined) {
      const details =
        envelope.errors
          ?.map((error) => error.message)
          .filter(Boolean)
          .join(', ') || `HTTP ${response.status}`;
      throw new PlatformCloudflareApiError(
        `Cloudflare API error: ${details} (HTTP ${response.status}; ${init?.method ?? 'GET'} ${path.split('?')[0]}).`,
        response.status,
        path.split('?')[0],
      );
    }
    return { result: envelope.result, resultInfo: envelope.result_info };
  }

  async listAccounts(): Promise<ReadonlyArray<CloudflareAccount>> {
    const entries: Array<{ id?: unknown; name?: unknown }> = [];
    for (let page = 1; ; page++) {
      const result = await this.request<ReadonlyArray<{ id?: unknown; name?: unknown }>>(
        `/accounts?page=${page}&per_page=50`,
      );
      entries.push(...result);
      if (result.length < 50) {
        break;
      }
    }
    return entries.map((entry) => ({
      id: requiredString(entry.id, 'Cloudflare account id'),
      name: requiredString(entry.name, 'Cloudflare account name'),
    }));
  }

  async getWorkersSubdomain(accountId: string): Promise<string> {
    const setupUrl = `https://dash.cloudflare.com/${encodeURIComponent(accountId)}/workers-and-pages`;
    let result: { subdomain?: unknown } | null;
    try {
      result = await this.request<{ subdomain?: unknown }>(
        `/accounts/${encodeURIComponent(accountId)}/workers/subdomain`,
      );
    } catch (error) {
      const status = error instanceof PlatformCloudflareApiError ? error.status : null;
      const reason = status === null ? 'the request failed' : `HTTP ${status}`;
      const guidance =
        status === 401 || status === 403
          ? 'Check your Cloudflare login or API token permissions for this account, then rerun the command.'
          : status === 404
            ? `Check ${setupUrl}. If no subdomain is shown, finish Workers onboarding and choose one; otherwise check account access and retry.`
            : 'Rerun the command. If the dashboard already shows a subdomain, no Workers onboarding change is needed.';
      throw new Error(
        `platform: Could not read the workers.dev subdomain for account ${accountId} (${reason}). ${guidance}`,
        { cause: error },
      );
    }
    if (typeof result?.subdomain !== 'string' || result.subdomain.trim() === '') {
      throw new Error(
        `platform: This Cloudflare account does not have a workers.dev subdomain. Open ${setupUrl}, finish Workers onboarding, choose a subdomain, and rerun the command.`,
      );
    }
    return result.subdomain.trim();
  }

  async listAiGateways(accountId: string): Promise<ReadonlyArray<CloudflareNamedResource>> {
    if (this.#aiGatewayClient) {
      return this.#aiGatewayClient.listAiGateways(accountId);
    }
    const entries: Array<{ id?: unknown }> = [];
    for (let page = 1; ; page++) {
      const result = await this.request<ReadonlyArray<{ id?: unknown }>>(
        `/accounts/${encodeURIComponent(accountId)}/ai-gateway/gateways?page=${page}&per_page=50`,
      );
      entries.push(...result);
      if (result.length < 50) {
        break;
      }
    }
    return entries.map((entry) => ({
      id: requiredString(entry.id, 'AI Gateway id'),
      name: requiredString(entry.id, 'AI Gateway id'),
    }));
  }

  async createAiGateway(accountId: string, id: string): Promise<CloudflareNamedResource> {
    if (this.#aiGatewayClient) {
      return this.#aiGatewayClient.createAiGateway(accountId, id);
    }
    const result = await this.request<{ id?: unknown }>(
      `/accounts/${encodeURIComponent(accountId)}/ai-gateway/gateways`,
      {
        method: 'POST',
        body: JSON.stringify({
          cache_invalidate_on_update: false,
          cache_ttl: null,
          collect_logs: true,
          id,
          rate_limiting_interval: null,
          rate_limiting_limit: null,
        }),
      },
    );
    return {
      id: requiredString(result.id, 'AI Gateway id'),
      name: id,
    };
  }

  async findZone(accountId: string, name: string): Promise<CloudflareZone | null> {
    const result = await this.request<ReadonlyArray<Record<string, unknown>>>(
      `/zones?account.id=${encodeURIComponent(accountId)}&name=${encodeURIComponent(name)}&per_page=50`,
    );
    const exact = result.find((zone) => zone.name === name);
    return exact ? parseZone(exact) : null;
  }

  async createZone(accountId: string, name: string): Promise<CloudflareZone> {
    return parseZone(
      await this.request<Record<string, unknown>>('/zones', {
        method: 'POST',
        body: JSON.stringify({ account: { id: accountId }, name, type: 'full' }),
      }),
    );
  }

  async findZoneForHostname(accountId: string, hostname: string): Promise<CloudflareZone | null> {
    const labels = hostname.split('.');
    for (let index = 0; index <= labels.length - 2; index++) {
      const zone = await this.findZone(accountId, labels.slice(index).join('.'));
      if (zone) {
        return zone;
      }
    }
    return null;
  }

  async listWorkerDomains(accountId: string): Promise<ReadonlyArray<CloudflareWorkerDomain>> {
    const result = await this.#listWorkerDomainRecords(accountId);
    return result.map((entry) => ({
      hostname: requiredString(entry.hostname, 'Worker custom domain hostname'),
      id: requiredString(entry.id, 'Worker custom domain id'),
      service: requiredString(entry.service, 'Worker custom domain service'),
      ...(typeof entry.zone_name === 'string' ? { zoneName: entry.zone_name } : {}),
    }));
  }

  /**
   * Add missing Custom Domains without replacing the Worker's existing set or
   * authorizing takeover of another Worker origin or DNS record. Wrangler
   * enables destructive overrides automatically without a TTY, so the
   * installer deliberately owns this mutation through the API instead.
   */
  async publishWorkerCustomDomainsSafely(
    accountId: string,
    workerName: string,
    origins: ReadonlyArray<CloudflareWorkerCustomDomainOrigin>,
  ): Promise<void> {
    const before = await this.listWorkerDomains(accountId);
    const pending = origins.filter((origin) => {
      const matches = before.filter((domain) => domain.hostname === origin.hostname);
      if (matches.length > 1 || matches.some((domain) => domain.service !== workerName)) {
        throw new PlatformWorkerCustomDomainsChangedError(
          `platform: Custom Domain ${JSON.stringify(origin.hostname)} changed concurrently before publication; refusing to replace its traffic state.`,
        );
      }
      return matches.length === 0;
    });
    if (pending.length === 0) {
      return;
    }
    try {
      await this.request(
        `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/domains/records`,
        {
          method: 'PUT',
          body: JSON.stringify({
            override_scope: false,
            override_existing_origin: false,
            override_existing_dns_record: false,
            origins: pending.map((origin) => ({
              hostname: origin.hostname,
              ...(origin.zoneId ? { zone_id: origin.zoneId } : {}),
              ...(origin.zoneName ? { zone_name: origin.zoneName } : {}),
              ...(origin.enabled === undefined ? {} : { enabled: origin.enabled }),
              ...(origin.previewsEnabled === undefined
                ? {}
                : { previews_enabled: origin.previewsEnabled }),
            })),
          }),
        },
      );
    } catch (error) {
      throw new PlatformWorkerCustomDomainsChangedError(
        `platform: Custom Domain publication for Worker ${JSON.stringify(workerName)} had an ambiguous outcome; retaining live domains for safe reconciliation.`,
        { cause: error },
      );
    }

    const expected = [...origins].map((origin) => origin.hostname).sort();
    const inventory = await this.listWorkerDomains(accountId);
    const actual = inventory
      .filter((domain) => domain.service === workerName)
      .map((domain) => domain.hostname)
      .sort();
    const everyExpectedDomainIsUniqueAndOwned = expected.every(
      (hostname) =>
        inventory.filter((domain) => domain.hostname === hostname && domain.service === workerName)
          .length === 1,
    );
    if (
      !everyExpectedDomainIsUniqueAndOwned ||
      expected.some((hostname) => !actual.includes(hostname))
    ) {
      throw new PlatformWorkerCustomDomainsChangedError(
        `platform: Worker ${JSON.stringify(workerName)} Custom Domains changed concurrently after publication; refusing to overwrite the newer traffic state.`,
      );
    }
  }

  async #listWorkerDomainRecords(
    accountId: string,
    service?: string,
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    const entries: Array<Record<string, unknown>> = [];
    const perPage = 100;
    for (let page = 1; ; page++) {
      const query = new URLSearchParams({ page: String(page), per_page: String(perPage) });
      if (service) {
        query.set('service', service);
      }
      const response = await this.#requestEnvelope<ReadonlyArray<Record<string, unknown>>>(
        `/accounts/${encodeURIComponent(accountId)}/workers/domains?${query}`,
      );
      entries.push(...response.result);
      const totalPages = response.resultInfo?.total_pages;
      if (
        (typeof totalPages === 'number' && page >= totalPages) ||
        (totalPages === undefined && response.result.length < perPage)
      ) {
        break;
      }
    }
    return entries;
  }

  async listWorkerRoutes(zoneId: string): Promise<ReadonlyArray<CloudflareWorkerRoute>> {
    const result = await this.request<ReadonlyArray<Record<string, unknown>>>(
      `/zones/${encodeURIComponent(zoneId)}/workers/routes`,
    );
    return result.map((entry) => ({
      id: requiredString(entry.id, 'Worker route id'),
      pattern: requiredString(entry.pattern, 'Worker route pattern'),
      script: typeof entry.script === 'string' ? entry.script : null,
    }));
  }

  async publishWorkerRoutesSafely(
    zoneId: string,
    workerName: string,
    patterns: ReadonlyArray<string>,
  ): Promise<void> {
    const before = await this.listWorkerRoutes(zoneId);
    const pending = patterns.filter((pattern) => {
      const matches = before.filter((route) => route.pattern === pattern);
      if (matches.length > 1 || matches.some((route) => route.script !== workerName)) {
        throw new PlatformWorkerRoutesChangedError(
          `platform: Worker route ${JSON.stringify(pattern)} changed concurrently before publication; refusing to replace its traffic state.`,
        );
      }
      return matches.length === 0;
    });
    for (const pattern of pending) {
      try {
        await this.request(`/zones/${encodeURIComponent(zoneId)}/workers/routes`, {
          body: JSON.stringify({ pattern, script: workerName }),
          method: 'POST',
        });
      } catch (error) {
        throw new PlatformWorkerRoutesChangedError(
          `platform: Worker route publication for ${JSON.stringify(pattern)} had an ambiguous outcome; retaining live routes for safe reconciliation.`,
          { cause: error },
        );
      }
    }
    const after = await this.listWorkerRoutes(zoneId);
    for (const pattern of patterns) {
      const matches = after.filter((route) => route.pattern === pattern);
      if (matches.length !== 1 || matches[0]!.script !== workerName) {
        throw new PlatformWorkerRoutesChangedError(
          `platform: Worker route ${JSON.stringify(pattern)} changed concurrently after publication; retaining live routes for safe reconciliation.`,
        );
      }
    }
  }

  async listWorkerServiceRoutes(
    accountId: string,
    workerName: string,
  ): Promise<ReadonlyArray<CloudflareWorkerServiceRoute>> {
    const result = await this.request<ReadonlyArray<Record<string, unknown>>>(
      `/accounts/${encodeURIComponent(accountId)}/workers/services/${encodeURIComponent(workerName)}/environments/production/routes?show_zonename=true`,
    );
    return result.map((entry) => ({
      pattern: requiredString(entry.pattern, 'Worker service route pattern'),
      zoneName: requiredString(entry.zone_name, 'Worker service route zone name'),
    }));
  }

  async listDnsRecords(zoneId: string, name: string): Promise<ReadonlyArray<CloudflareDnsRecord>> {
    const query = new URLSearchParams({ name, per_page: '100' });
    const result = await this.request<ReadonlyArray<Record<string, unknown>>>(
      `/zones/${encodeURIComponent(zoneId)}/dns_records?${query}`,
    );
    return result.map(parseDnsRecord);
  }

  /** Read deployed edge certificates; requesting a pack is not proof of issuance. */
  async hasActiveCertificateForHostname(zoneId: string, hostname: string): Promise<boolean> {
    const expected = hostname.toLowerCase().replace(/\.$/, '');
    const covers = (value: unknown): boolean => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
      }
      const cert = value as Record<string, unknown>;
      if (cert.status !== 'active' || !Array.isArray(cert.hosts)) {
        return false;
      }
      if (
        cert.expires_on !== undefined &&
        (typeof cert.expires_on !== 'string' ||
          !Number.isFinite(Date.parse(cert.expires_on)) ||
          Date.parse(cert.expires_on) <= Date.now())
      ) {
        return false;
      }
      return cert.hosts.some(
        (host) => typeof host === 'string' && host.toLowerCase().replace(/\.$/, '') === expected,
      );
    };
    for (const kind of ['ssl/certificate_packs', 'custom_certificates']) {
      for (let page = 1; page <= 200; page++) {
        const query = new URLSearchParams({ page: String(page), per_page: '50' });
        if (kind === 'ssl/certificate_packs') {
          query.set('deploy', 'production');
        }
        const { result, resultInfo } = await this.#requestEnvelope<
          ReadonlyArray<Record<string, unknown>>
        >(`/zones/${encodeURIComponent(zoneId)}/${kind}?${query}`);
        if (!Array.isArray(result)) {
          throw new Error('platform: Cloudflare returned an invalid certificate inventory.');
        }
        for (const entry of result) {
          const certificates =
            kind === 'ssl/certificate_packs'
              ? Array.isArray(entry.certificates)
                ? entry.certificates
                : []
              : [entry];
          if (certificates.some(covers)) {
            return true;
          }
        }
        if (
          result.length === 0 ||
          (resultInfo?.total_pages !== undefined
            ? page >= resultInfo.total_pages
            : result.length < 50)
        ) {
          break;
        }
        if (page === 200) {
          throw new Error('platform: Certificate inventory is too large to verify safely.');
        }
      }
    }
    return false;
  }

  async createDnsRecord(zoneId: string, name: string): Promise<CloudflareDnsRecord> {
    return parseDnsRecord(
      await this.request<Record<string, unknown>>(
        `/zones/${encodeURIComponent(zoneId)}/dns_records`,
        {
          method: 'POST',
          body: JSON.stringify({ content: '100::', name, proxied: true, ttl: 1, type: 'AAAA' }),
        },
      ),
    );
  }

  async listKvNamespaces(
    accountId: string,
    title?: string,
  ): Promise<ReadonlyArray<CloudflareNamedResource>> {
    const entries: Array<{ id?: unknown; title?: unknown }> = [];
    for (let page = 1; ; page++) {
      const query = new URLSearchParams({ page: String(page), per_page: '100' });
      const result = await this.request<ReadonlyArray<{ id?: unknown; title?: unknown }>>(
        `/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces?${query}`,
      );
      entries.push(...result);
      if (result.length < 100) {
        break;
      }
    }
    const namespaces = entries.map((entry) => ({
      id: requiredString(entry.id, 'KV namespace id'),
      name: requiredString(entry.title, 'KV namespace title'),
    }));
    // The KV API lists all namespaces; it does not filter by a `title` parameter.
    // Filter only after pagination and validation, without hiding real duplicates.
    return title ? namespaces.filter((namespace) => namespace.name === title) : namespaces;
  }

  async createKvNamespace(accountId: string, title: string): Promise<CloudflareNamedResource> {
    const result = await this.request<{ id?: unknown; title?: unknown }>(
      `/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces`,
      { method: 'POST', body: JSON.stringify({ title }) },
    );
    return {
      id: requiredString(result.id, 'KV namespace id'),
      name: typeof result.title === 'string' ? result.title : title,
    };
  }

  async listR2Buckets(accountId: string): Promise<ReadonlyArray<CloudflareNamedResource>> {
    const buckets: Array<{ creation_date?: unknown; name?: unknown }> = [];
    let startAfter = '';
    for (;;) {
      const query = new URLSearchParams({ direction: 'asc', order: 'name', per_page: '1000' });
      if (startAfter) {
        query.set('start_after', startAfter);
      }
      const result = await this.request<
        | { buckets?: ReadonlyArray<{ creation_date?: unknown; name?: unknown }> }
        | ReadonlyArray<{ creation_date?: unknown; name?: unknown }>
      >(`/accounts/${encodeURIComponent(accountId)}/r2/buckets?${query}`);
      const page = Array.isArray(result)
        ? result
        : 'buckets' in result
          ? (result.buckets ?? [])
          : [];
      buckets.push(...page);
      if (page.length < 1000) {
        break;
      }
      const next = requiredString(page.at(-1)?.name, 'R2 bucket name');
      if (next === startAfter) {
        throw new Error('platform: Cloudflare returned a non-advancing R2 bucket page.');
      }
      startAfter = next;
    }
    return buckets.map((entry) => {
      const name = requiredString(entry.name, 'R2 bucket name');
      return {
        fingerprint: requiredString(entry.creation_date, 'R2 bucket creation date'),
        id: name,
        name,
      };
    });
  }

  async createR2Bucket(accountId: string, name: string): Promise<CloudflareNamedResource> {
    const result = await this.request<{ creation_date?: unknown; name?: unknown }>(
      `/accounts/${encodeURIComponent(accountId)}/r2/buckets`,
      { method: 'POST', body: JSON.stringify({ name }) },
    );
    const resultName = typeof result.name === 'string' ? result.name : name;
    const fingerprint =
      typeof result.creation_date === 'string' && result.creation_date
        ? result.creation_date
        : (await this.listR2Buckets(accountId)).find((bucket) => bucket.name === resultName)
            ?.fingerprint;
    if (!fingerprint) {
      throw new Error(
        `platform: Cloudflare created R2 bucket ${JSON.stringify(resultName)} without returning a verifiable creation fingerprint.`,
      );
    }
    return {
      fingerprint,
      id: resultName,
      name: resultName,
    };
  }

  async listQueues(
    accountId: string,
    name: string,
  ): Promise<ReadonlyArray<CloudflareNamedResource>> {
    const result = await this.request<ReadonlyArray<{ queue_id?: unknown; queue_name?: unknown }>>(
      `/accounts/${encodeURIComponent(accountId)}/queues?name=${encodeURIComponent(name)}&per_page=100`,
    );
    return result.map((entry) => ({
      id: requiredString(entry.queue_id, 'Queue id'),
      name: requiredString(entry.queue_name, 'Queue name'),
    }));
  }

  async createQueue(accountId: string, name: string): Promise<CloudflareNamedResource> {
    const result = await this.request<{ queue_id?: unknown; queue_name?: unknown }>(
      `/accounts/${encodeURIComponent(accountId)}/queues`,
      { method: 'POST', body: JSON.stringify({ queue_name: name }) },
    );
    return {
      id: requiredString(result.queue_id, 'Queue id'),
      name: typeof result.queue_name === 'string' ? result.queue_name : name,
    };
  }

  async listDispatchNamespaces(accountId: string): Promise<ReadonlyArray<CloudflareNamedResource>> {
    const result = await this.request<
      ReadonlyArray<{ namespace_id?: unknown; namespace_name?: unknown }>
    >(`/accounts/${encodeURIComponent(accountId)}/workers/dispatch/namespaces`);
    return result.map((entry) => ({
      id: requiredString(entry.namespace_id, 'Dispatch namespace id'),
      name: requiredString(entry.namespace_name, 'Dispatch namespace name'),
    }));
  }

  async createDispatchNamespace(accountId: string, name: string): Promise<CloudflareNamedResource> {
    const result = await this.request<{ namespace_id?: unknown; namespace_name?: unknown }>(
      `/accounts/${encodeURIComponent(accountId)}/workers/dispatch/namespaces`,
      { method: 'POST', body: JSON.stringify({ name }) },
    );
    return {
      id: requiredString(result.namespace_id, 'Dispatch namespace id'),
      name: typeof result.namespace_name === 'string' ? result.namespace_name : name,
    };
  }

  async listHyperdriveConfigs(accountId: string): Promise<ReadonlyArray<CloudflareNamedResource>> {
    const entries: Array<{ id?: unknown; name?: unknown }> = [];
    for (let page = 1; ; page++) {
      const result = await this.request<ReadonlyArray<{ id?: unknown; name?: unknown }>>(
        `/accounts/${encodeURIComponent(accountId)}/hyperdrive/configs?page=${page}&per_page=50`,
      );
      entries.push(...result);
      if (result.length < 50) {
        break;
      }
    }
    return entries.map((entry) => ({
      id: requiredString(entry.id, 'Hyperdrive id'),
      name: requiredString(entry.name, 'Hyperdrive name'),
    }));
  }

  async getHyperdriveConfig(accountId: string, id: string): Promise<CloudflareHyperdriveConfig> {
    const result = await this.request<Record<string, unknown>>(
      `/accounts/${encodeURIComponent(accountId)}/hyperdrive/configs/${encodeURIComponent(id)}`,
    );
    return parseHyperdriveConfig(result);
  }

  async createHyperdrive(
    accountId: string,
    name: string,
    connectionString: string,
  ): Promise<CloudflareNamedResource> {
    const parsed = parsePostgresConnectionString(connectionString);
    const result = await this.request<{ id?: unknown; name?: unknown }>(
      `/accounts/${encodeURIComponent(accountId)}/hyperdrive/configs`,
      {
        method: 'POST',
        body: JSON.stringify({
          name,
          caching: { disabled: true },
          origin: {
            database: parsed.database,
            host: parsed.host,
            password: parsed.password,
            port: parsed.port,
            scheme: 'postgresql',
            user: parsed.user,
          },
          ...(parsed.mtls ? { mtls: parsed.mtls } : {}),
        }),
      },
    );
    return {
      id: requiredString(result.id, 'Hyperdrive id'),
      name: typeof result.name === 'string' ? result.name : name,
    };
  }

  async listWorkerNames(accountId: string): Promise<ReadonlyArray<string>> {
    const result = await this.request<ReadonlyArray<{ id?: unknown }>>(
      `/accounts/${encodeURIComponent(accountId)}/workers/scripts`,
    );
    return result.map((entry) => requiredString(entry.id, 'Worker name'));
  }

  async disableHyperdriveCaching(accountId: string, id: string): Promise<void> {
    await this.request(
      `/accounts/${encodeURIComponent(accountId)}/hyperdrive/configs/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ caching: { disabled: true } }),
      },
    );
  }

  async putKvValue(
    accountId: string,
    namespaceId: string,
    key: string,
    value: string,
  ): Promise<void> {
    await this.request(
      `/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces/${encodeURIComponent(namespaceId)}/values/${encodeURIComponent(key)}`,
      { method: 'PUT', body: value, headers: { 'Content-Type': 'application/json' } },
    );
  }

  async getKvValue(accountId: string, namespaceId: string, key: string): Promise<string | null> {
    const response = await this.#fetcher(
      `${this.apiBaseUrl}/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces/${encodeURIComponent(namespaceId)}/values/${encodeURIComponent(key)}`,
      {
        headers: { Authorization: `Bearer ${this.#token}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new PlatformCloudflareApiError(
        `Cloudflare API error reading the installation manifest (HTTP ${response.status}).`,
        response.status,
      );
    }
    return response.text();
  }

  async putR2Object(
    accountId: string,
    bucketName: string,
    key: string,
    value: string,
  ): Promise<void> {
    const response = await this.#fetcher(
      `${this.apiBaseUrl}/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucketName)}/objects/${encodeR2ObjectKey(key)}`,
      {
        body: value,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          'Content-Type': 'application/json',
        },
        method: 'PUT',
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new PlatformCloudflareApiError(
        `Cloudflare API error writing the R2 ownership marker (HTTP ${response.status}).`,
        response.status,
      );
    }
  }

  async getR2Object(accountId: string, bucketName: string, key: string): Promise<string | null> {
    const response = await this.#fetcher(
      `${this.apiBaseUrl}/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucketName)}/objects/${encodeR2ObjectKey(key)}`,
      {
        headers: { Authorization: `Bearer ${this.#token}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new PlatformCloudflareApiError(
        `Cloudflare API error reading the R2 ownership marker (HTTP ${response.status}).`,
        response.status,
      );
    }
    return response.text();
  }

  async deleteR2Object(accountId: string, bucketName: string, key: string): Promise<void> {
    try {
      await this.deleteR2Objects(accountId, bucketName, [key]);
    } catch (error) {
      if (error instanceof PlatformCloudflareApiError && error.status === 404) {
        return;
      }
      throw error;
    }
  }

  async getWorkerPlainTextBindings(
    accountId: string,
    workerName: string,
  ): Promise<Readonly<Record<string, string>>> {
    const settings = await this.request<{
      bindings?: ReadonlyArray<{ name?: unknown; text?: unknown; type?: unknown }>;
    }>(
      `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/settings`,
    );
    const bindings: Record<string, string> = {};
    for (const binding of settings.bindings ?? []) {
      if (
        binding.type === 'plain_text' &&
        typeof binding.name === 'string' &&
        typeof binding.text === 'string'
      ) {
        bindings[binding.name] = binding.text;
      }
    }
    return bindings;
  }

  async deleteKvValue(accountId: string, namespaceId: string, key: string): Promise<void> {
    try {
      await this.request(
        `/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces/${encodeURIComponent(namespaceId)}/values/${encodeURIComponent(key)}`,
        { method: 'DELETE' },
      );
    } catch (error) {
      if (error instanceof PlatformCloudflareApiError && error.status === 404) {
        return;
      }
      throw error;
    }
  }

  async emptyR2Bucket(
    accountId: string,
    bucketName: string,
    preservedKeys: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    let cursor = '';
    const observedCursors = new Set<string>();
    for (;;) {
      const query = new URLSearchParams({ per_page: '1000' });
      if (cursor) {
        query.set('cursor', cursor);
      }
      const response = await this.#fetcher(
        `${this.apiBaseUrl}/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucketName)}/objects?${query}`,
        {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${this.#token}`,
          },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (response.status === 404) {
        return;
      }
      const envelope = (await response.json()) as CloudflareEnvelope<
        ReadonlyArray<{ key?: unknown }>
      >;
      if (!response.ok || envelope.success !== true || !Array.isArray(envelope.result)) {
        const details =
          envelope.errors
            ?.map((error) => error.message)
            .filter(Boolean)
            .join(', ') || `HTTP ${response.status}`;
        throw new PlatformCloudflareApiError(
          `Cloudflare API error listing R2 objects: ${details}`,
          response.status,
        );
      }
      const keys = envelope.result
        .map((object) => requiredString(object.key, 'R2 object key'))
        .filter((key) => !preservedKeys.has(key));
      for (let offset = 0; offset < keys.length; offset += 1000) {
        await this.deleteR2Objects(accountId, bucketName, keys.slice(offset, offset + 1000));
      }
      const nextCursor = envelope.result_info?.cursor ?? '';
      if (!nextCursor) {
        return;
      }
      if (observedCursors.has(nextCursor)) {
        throw new Error('platform: Cloudflare returned a repeated R2 object cursor.');
      }
      observedCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }

  private async deleteR2Objects(
    accountId: string,
    bucketName: string,
    keys: ReadonlyArray<string>,
  ): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    const deleted = await this.request<ReadonlyArray<{ key?: unknown }>>(
      `/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucketName)}/objects`,
      { body: JSON.stringify(keys), method: 'DELETE' },
    );
    const deletedKeys = new Set(
      deleted.map((entry) => requiredString(entry.key, 'deleted R2 object key')),
    );
    const missing = keys.find((key) => !deletedKeys.has(key));
    if (missing !== undefined) {
      throw new Error('platform: Cloudflare did not confirm every requested R2 object deletion.');
    }
  }

  async deleteResource(
    accountId: string,
    kind: string,
    id: string,
    zoneId?: string,
  ): Promise<void> {
    const account = encodeURIComponent(accountId);
    const encoded = encodeURIComponent(id);
    const path =
      kind === 'kv-namespace'
        ? `/accounts/${account}/storage/kv/namespaces/${encoded}`
        : kind === 'dns-record'
          ? zoneId
            ? `/zones/${encodeURIComponent(zoneId)}/dns_records/${encoded}`
            : null
          : kind === 'ai-gateway'
            ? `/accounts/${account}/ai-gateway/gateways/${encoded}`
            : kind === 'r2-bucket'
              ? `/accounts/${account}/r2/buckets/${encoded}`
              : kind === 'queue'
                ? `/accounts/${account}/queues/${encoded}`
                : kind === 'dispatch-namespace'
                  ? `/accounts/${account}/workers/dispatch/namespaces/${encoded}`
                  : kind === 'hyperdrive'
                    ? `/accounts/${account}/hyperdrive/configs/${encoded}`
                    : kind === 'worker'
                      ? `/accounts/${account}/workers/scripts/${encoded}`
                      : kind === 'zone'
                        ? `/zones/${encoded}`
                        : null;
    if (!path) {
      throw new Error(`platform: Unsupported Cloudflare deletion kind ${kind}.`);
    }
    try {
      await this.request(path, { method: 'DELETE' });
    } catch (error) {
      if (error instanceof PlatformCloudflareApiError && error.status === 404) {
        return;
      }
      throw error;
    }
  }

  async removeRoutes(
    _accountId: string,
    _zoneId: string | null,
    tracked: PlatformTrackedWorkerTraffic,
  ): Promise<void> {
    if (tracked.routes.length > 0 || tracked.customDomains.length > 0) {
      throw new Error(
        'platform: Cloudflare does not support conditional Worker traffic deletion. Retaining routes and custom domains for explicit dashboard cleanup.',
      );
    }
  }

  async setWorkerSubdomain(accountId: string, workerName: string, enabled: boolean): Promise<void> {
    try {
      await this.request(
        `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/subdomain`,
        {
          body: JSON.stringify({ enabled, previews_enabled: enabled }),
          headers: { 'Cloudflare-Workers-Script-Api-Date': '2025-08-01' },
          method: 'POST',
        },
      );
    } catch (error) {
      if (!enabled && error instanceof PlatformCloudflareApiError && error.status === 404) {
        return;
      }
      throw error;
    }
  }
}

function encodeR2ObjectKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`platform: ${label} is missing from the Cloudflare response.`);
  }
  return value;
}

function parseZone(value: Record<string, unknown>): CloudflareZone {
  return {
    id: requiredString(value.id, 'Zone id'),
    name: requiredString(value.name, 'Zone name'),
    nameServers: Array.isArray(value.name_servers)
      ? value.name_servers.filter((entry): entry is string => typeof entry === 'string')
      : [],
    status: requiredString(value.status, 'Zone status'),
  };
}

function parseDnsRecord(value: Record<string, unknown>): CloudflareDnsRecord {
  return {
    content: requiredString(value.content, 'DNS record content'),
    id: requiredString(value.id, 'DNS record id'),
    name: requiredString(value.name, 'DNS record name'),
    proxied: value.proxied === true,
    type: requiredString(value.type, 'DNS record type'),
  };
}

export function parsePostgresConnectionString(value: string): {
  database: string;
  host: string;
  mtls?: Readonly<{ sslmode: 'require' }>;
  password: string;
  port: number;
  user: string;
} {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('platform: DATABASE_URL must be a PostgreSQL connection string.');
  }
  if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') || !url.hostname) {
    throw new Error('platform: DATABASE_URL must use postgres:// or postgresql://.');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!url.username || !url.password || !database) {
    throw new Error('platform: DATABASE_URL must include username, password, host, and database.');
  }
  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error('platform: DATABASE_URL has an invalid PostgreSQL port.');
  }
  const sslmode = url.searchParams.get('sslmode');
  let mtls: Readonly<{ sslmode: 'require' }> | undefined;
  if (sslmode) {
    if (sslmode !== 'require' && sslmode !== 'verify-ca' && sslmode !== 'verify-full') {
      throw new Error(
        'platform: Unsupported sslmode. Cloudflare Hyperdrive supports "require", "verify-ca", or "verify-full".',
      );
    }
    // Hyperdrive accepts its verify modes only with an uploaded CA certificate ID, which a
    // connection URL cannot carry. `require` is Hyperdrive's TLS mode that validates the server
    // certificate against public CAs; Void's own database connections still use the URL's mode.
    mtls = { sslmode: 'require' };
  }
  return {
    database,
    host: url.hostname,
    ...(mtls ? { mtls } : {}),
    password: decodeURIComponent(url.password),
    port,
    user: decodeURIComponent(url.username),
  };
}

export function hyperdriveOriginFromConnectionString(value: string): CloudflareHyperdriveOrigin {
  const parsed = parsePostgresConnectionString(value);
  return {
    database: parsed.database,
    host: parsed.host.toLowerCase(),
    port: parsed.port,
    scheme: 'postgresql',
    user: parsed.user,
  };
}

export function hyperdriveOriginConfigHash(origin: CloudflareHyperdriveOrigin): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        database: origin.database,
        host: origin.host.toLowerCase(),
        port: origin.port,
        scheme: 'postgresql',
        user: origin.user,
      }),
    )
    .digest('hex');
}

export function hyperdriveOriginMatches(
  live: CloudflareHyperdriveOrigin,
  expected: CloudflareHyperdriveOrigin,
): boolean {
  return (
    live.database === expected.database &&
    live.host.toLowerCase() === expected.host.toLowerCase() &&
    live.port === expected.port &&
    live.scheme === expected.scheme &&
    (live.user === null || live.user === expected.user)
  );
}

function parseHyperdriveConfig(value: Record<string, unknown>): CloudflareHyperdriveConfig {
  const origin = value.origin;
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) {
    throw new Error('platform: Cloudflare Hyperdrive config has no origin metadata.');
  }
  const record = origin as Record<string, unknown>;
  const scheme = requiredString(record.scheme, 'Hyperdrive origin scheme').toLowerCase();
  if (scheme !== 'postgres' && scheme !== 'postgresql') {
    throw new Error(`platform: Unsupported Hyperdrive origin scheme ${JSON.stringify(scheme)}.`);
  }
  const port = typeof record.port === 'number' ? record.port : Number(record.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error('platform: Cloudflare Hyperdrive config has an invalid origin port.');
  }
  return {
    id: requiredString(value.id, 'Hyperdrive id'),
    name: requiredString(value.name, 'Hyperdrive name'),
    cachingDisabled:
      !!value.caching &&
      typeof value.caching === 'object' &&
      !Array.isArray(value.caching) &&
      (value.caching as Record<string, unknown>).disabled === true,
    origin: {
      database: requiredString(record.database, 'Hyperdrive origin database'),
      host: requiredString(record.host, 'Hyperdrive origin host').toLowerCase(),
      port,
      scheme: 'postgresql',
      user: typeof record.user === 'string' && record.user ? record.user : null,
    },
  };
}
