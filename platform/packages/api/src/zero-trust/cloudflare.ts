import type { ManagedAccessApplication } from './configuration.ts';

type ObjectValue = Record<string, unknown>;

type CloudflareEnvelope<T> = Readonly<{
  success?: boolean;
  result?: T;
  errors?: ReadonlyArray<{ code?: number; message?: string }>;
}>;

export class ZeroTrustCloudflareError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ZeroTrustCloudflareError';
  }
}

function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Cloudflare returned an invalid ${label}.`);
  }
  return value as ObjectValue;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 8192) {
    throw new Error(`Cloudflare did not return ${label}.`);
  }
  return value;
}

function destinationList(application: ObjectValue): ReadonlyArray<string> {
  const destinations = Array.isArray(application.destinations) ? application.destinations : [];
  return [
    ...(typeof application.domain === 'string' ? [application.domain] : []),
    ...destinations.flatMap((value) => {
      const destination = object(value, 'Access application destination');
      return destination.type === 'public' && typeof destination.uri === 'string'
        ? [destination.uri]
        : [];
    }),
  ].filter((value, index, all) => all.indexOf(value) === index);
}

/**
 * A rule that names company identities. The CLI checks the Access policies
 * that protect the platform installation itself with a separate copy in
 * packages/void/src/cli/platform-access-provision.ts, because the public CLI
 * cannot import platform code. This list also accepts azureAD, login_method
 * and auth_context rules; review both when adding a rule type.
 */
function identityRule(rule: ObjectValue): boolean {
  if (rule.email_domain) {
    const domain = object(rule.email_domain, 'email domain').domain;
    return typeof domain === 'string' && /^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/i.test(domain);
  }
  if (rule.email) {
    const email = object(rule.email, 'email rule').email;
    return typeof email === 'string' && /^[^\s*@]+@[^\s*@]+\.[^\s*@]+$/.test(email);
  }
  return [
    'email_list',
    'gsuite',
    'github-organization',
    'saml',
    'okta',
    'azureAD',
    'login_method',
    'auth_context',
    'group',
  ].some(
    (key) =>
      Object.hasOwn(rule, key) &&
      !!rule[key] &&
      typeof rule[key] === 'object' &&
      !Array.isArray(rule[key]) &&
      Object.keys(rule[key] as object).length > 0,
  );
}

type AccessApplicationSpec = Readonly<{
  name: string;
  destinations: ReadonlyArray<string>;
  allowedIdentityProviderIds?: ReadonlyArray<string>;
  policies: ReadonlyArray<ObjectValue>;
}>;

function sameDestinations(
  application: ObjectValue,
  expectedDestinations: ReadonlyArray<string>,
): boolean {
  const actual = [...destinationList(application)].sort();
  const expected = [...new Set(expectedDestinations)].sort();
  return (
    actual.length === expected.length &&
    expected.every((destination, index) => destination === actual[index])
  );
}

function samePolicies(actualValue: unknown, expected: ReadonlyArray<ObjectValue>): boolean {
  if (!Array.isArray(actualValue) || actualValue.length !== expected.length) {
    return false;
  }
  return expected.every((expectedPolicy, index) => {
    const actualPolicy = object(actualValue[index], 'Access application policy');
    if (actualPolicy.precedence !== expectedPolicy.precedence) {
      return false;
    }
    if (typeof expectedPolicy.id === 'string') {
      return actualPolicy.id === expectedPolicy.id;
    }
    return (
      actualPolicy.decision === expectedPolicy.decision &&
      JSON.stringify(actualPolicy.include) === JSON.stringify(expectedPolicy.include)
    );
  });
}

function applicationConfigurationDrift(
  application: ObjectValue,
  spec: AccessApplicationSpec,
): boolean {
  const expectedIdps = [...(spec.allowedIdentityProviderIds ?? [])].sort();
  const actualIdps = Array.isArray(application.allowed_idps)
    ? application.allowed_idps.filter((value): value is string => typeof value === 'string').sort()
    : [];
  const idpsDrifted = spec.allowedIdentityProviderIds
    ? actualIdps.length !== expectedIdps.length ||
      !expectedIdps.every((id, index) => id === actualIdps[index]) ||
      application.auto_redirect_to_identity !== (expectedIdps.length === 1)
    : actualIdps.length > 0 || application.auto_redirect_to_identity === true;
  return (
    application.name !== spec.name ||
    application.type !== 'self_hosted' ||
    application.session_duration !== '12h' ||
    !sameDestinations(application, spec.destinations) ||
    idpsDrifted ||
    !samePolicies(application.policies, spec.policies)
  );
}

export class ZeroTrustCloudflareClient {
  readonly #base: string;

  constructor(
    accountId: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = (input, options) => fetch(input, options),
    apiBase = 'https://api.cloudflare.com/client/v4',
  ) {
    this.#base = `${apiBase.replace(/\/+$/, '')}/accounts/${encodeURIComponent(accountId)}/access`;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetcher(`${this.#base}/${path.replace(/^\/+/, '')}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.token}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
      redirect: 'manual',
      signal: init?.signal ?? AbortSignal.timeout(30_000),
    });
    let body: CloudflareEnvelope<T>;
    try {
      body = (await response.json()) as CloudflareEnvelope<T>;
    } catch {
      throw new ZeroTrustCloudflareError(
        `Cloudflare returned a non-JSON response (HTTP ${response.status}).`,
        response.status,
      );
    }
    if (!response.ok || body.success !== true || body.result === undefined) {
      const detail =
        body.errors
          ?.map((error) => error.message)
          .filter(Boolean)
          .join(', ') || `HTTP ${response.status}`;
      throw new ZeroTrustCloudflareError(
        `Cloudflare Zero Trust API error: ${detail} (HTTP ${response.status}).`,
        response.status,
      );
    }
    return body.result;
  }

  async getOrganization(): Promise<{ teamDomain: string }> {
    const organization = object(await this.request('organizations'), 'Access organization');
    const authDomain = text(organization.auth_domain, 'Access team domain');
    const teamDomain = (
      authDomain.startsWith('https://') ? authDomain : `https://${authDomain}`
    ).replace(/\/+$/, '');
    const url = new URL(teamDomain);
    if (
      url.protocol !== 'https:' ||
      !url.hostname.endsWith('.cloudflareaccess.com') ||
      url.origin !== teamDomain
    ) {
      throw new Error('Cloudflare returned an invalid Access team domain.');
    }
    return { teamDomain };
  }

  async validateSelection(input: {
    identityProviderIds: ReadonlyArray<string>;
    policyIds: ReadonlyArray<string>;
  }): Promise<{ teamDomain: string }> {
    const [{ teamDomain }, ...providers] = await Promise.all([
      this.getOrganization(),
      ...input.identityProviderIds.map((id) =>
        this.request(`identity_providers/${encodeURIComponent(id)}`),
      ),
    ]);
    for (const [index, provider] of providers.entries()) {
      if (
        text(object(provider, 'identity provider').id, 'identity provider id') !==
        input.identityProviderIds[index]
      ) {
        throw new Error(
          `Cloudflare Access identity provider ${input.identityProviderIds[index]} is unavailable.`,
        );
      }
    }
    const policies = await Promise.all(
      input.policyIds.map((id) =>
        this.request(`policies/${encodeURIComponent(id)}`).then((value) =>
          object(value, 'Access policy'),
        ),
      ),
    );
    await this.verifyCompanyPolicies(policies);
    return { teamDomain };
  }

  private async verifyCompanyPolicies(policies: ReadonlyArray<ObjectValue>): Promise<void> {
    let allowPolicies = 0;
    const inspectedGroups = new Set<string>();
    const activeGroups = new Set<string>();
    const checkRules = async (value: unknown, depth = 0): Promise<void> => {
      if (value === undefined) {
        return;
      }
      if (!Array.isArray(value) || value.length > 100 || depth > 8) {
        throw new Error('Access policies must contain bounded identity rules.');
      }
      for (const raw of value) {
        const rule = object(raw, 'Access policy rule');
        if (Object.hasOwn(rule, 'everyone') || Object.hasOwn(rule, 'any_valid_service_token')) {
          throw new Error('Access project policies must not allow Everyone or any service token.');
        }
        if (rule.group) {
          const id = text(object(rule.group, 'Access group rule').id, 'Access group id');
          if (activeGroups.has(id)) {
            throw new Error('Access groups contain a recursive membership rule.');
          }
          if (!inspectedGroups.has(id)) {
            if (inspectedGroups.size >= 100) {
              throw new Error('Access group policy exceeds the inspection limit.');
            }
            activeGroups.add(id);
            const group = object(
              await this.request(`groups/${encodeURIComponent(id)}`),
              'Access group',
            );
            await checkRules(group.include, depth + 1);
            await checkRules(group.require, depth + 1);
            if (!Array.isArray(group.include) || group.include.length < 1) {
              throw new Error('Access groups must contain explicit identity rules.');
            }
            const groupHasRequiredIdentity =
              Array.isArray(group.require) &&
              group.require.some((entry) => identityRule(object(entry, 'Access group rule')));
            if (
              !groupHasRequiredIdentity &&
              !group.include.every((entry) => identityRule(object(entry, 'Access group rule')))
            ) {
              throw new Error('Access groups must restrict company identities.');
            }
            activeGroups.delete(id);
            inspectedGroups.add(id);
          }
        }
      }
    };
    for (const policy of policies) {
      if (policy.decision === 'bypass' || policy.decision === 'non_identity') {
        throw new Error('Bypass and non-identity policies cannot protect Void projects.');
      }
      if (policy.decision !== 'allow' && policy.decision !== 'deny') {
        throw new Error('Unsupported Cloudflare Access policy decision.');
      }
      if (policy.decision === 'allow') {
        allowPolicies += 1;
        await checkRules(policy.include);
        await checkRules(policy.require);
        const hasRequiredIdentity =
          Array.isArray(policy.require) &&
          policy.require.some((entry) => identityRule(object(entry, 'Access policy rule')));
        if (
          !Array.isArray(policy.include) ||
          policy.include.length < 1 ||
          (!hasRequiredIdentity &&
            !policy.include.every((entry) => identityRule(object(entry, 'Access policy rule'))))
        ) {
          throw new Error('Access allow policies must restrict company identities.');
        }
      }
    }
    if (allowPolicies === 0) {
      throw new Error('Select at least one Cloudflare Access allow policy.');
    }
  }

  private applicationBody(spec: AccessApplicationSpec): ObjectValue {
    const destinations = [...new Set(spec.destinations)];
    if (destinations.length < 1 || destinations.length > 100) {
      throw new Error('An Access application needs between 1 and 100 destinations.');
    }
    return {
      name: spec.name,
      type: 'self_hosted',
      domain: destinations[0],
      destinations: destinations.map((uri) => ({ type: 'public', uri })),
      session_duration: '12h',
      ...(spec.allowedIdentityProviderIds
        ? {
            allowed_idps: [...spec.allowedIdentityProviderIds],
            auto_redirect_to_identity: spec.allowedIdentityProviderIds.length === 1,
          }
        : {}),
      policies: [...spec.policies],
    };
  }

  private async applications(): Promise<Map<string, ObjectValue>> {
    // Name checkpoints can come from another request after any earlier inventory.
    // Always refresh before using a name to recover ownership or establish absence.
    const entries: Array<ObjectValue> = [];
    for (let page = 1; page <= 6; page++) {
      const result = await this.request<ReadonlyArray<unknown>>(`apps?page=${page}&per_page=100`);
      const parsed = result.map((entry) => object(entry, 'Access application'));
      if (page === 6 && parsed.length > 0) {
        throw new Error(
          'Cloudflare Access has more than 500 applications; Void cannot safely reconcile this installation within provider limits.',
        );
      }
      entries.push(...parsed);
      if (parsed.length < 100) {
        break;
      }
    }
    return new Map(
      entries.map((application) => [text(application.id, 'application id'), application]),
    );
  }

  private async application(id: string): Promise<ObjectValue | null> {
    try {
      const application = object(
        await this.request(`apps/${encodeURIComponent(id)}`),
        'Access application',
      );
      if (text(application.id, 'application id') !== id) {
        throw new Error('Cloudflare returned a different Access application id.');
      }
      return application;
    } catch (error) {
      if (error instanceof ZeroTrustCloudflareError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  private verifyApplication(
    application: ObjectValue,
    spec: AccessApplicationSpec,
  ): ManagedAccessApplication {
    const id = text(application.id, 'application id');
    const expectedDestinations = [...new Set(spec.destinations)].sort();
    if (applicationConfigurationDrift(application, spec)) {
      throw new Error('Cloudflare Access did not retain the requested application configuration.');
    }
    return {
      id,
      name: spec.name,
      audience: text(application.aud, 'application audience'),
      destinations: expectedDestinations,
    };
  }

  /**
   * Find the application Void recorded: by id first, then by its Void-owned
   * name. The name carries a random nonce committed before any create, so when
   * the recorded id is gone, the single application holding that name is
   * Void's own replacement whose create response was lost. `inventory` is
   * set when the name lookup ran.
   */
  private async locateOwnedApplication(
    id: string | null | undefined,
    name: string | null | undefined,
  ): Promise<{ application: ObjectValue | null; inventory?: Map<string, ObjectValue> }> {
    const application = id ? await this.application(id) : null;
    if (application) {
      if (name && application.name !== name) {
        throw new Error('The recorded Access application no longer has its Void-owned name.');
      }
      return { application };
    }
    if (!name) {
      return { application: null };
    }
    const inventory = await this.applications();
    const sameName = [...inventory.values()].filter((entry) => entry.name === name);
    if (sameName.length > 1) {
      throw new Error(`Multiple Cloudflare Access applications are named ${name}.`);
    }
    return { application: sameName[0] ?? null, inventory };
  }

  async ensureApplication(
    spec: AccessApplicationSpec,
    current?: Readonly<{ id?: string | null; name?: string | null }>,
  ): Promise<ManagedAccessApplication> {
    if (current?.name && current.name !== spec.name) {
      throw new Error('The recorded Access application no longer has its Void-owned name.');
    }
    let application: ObjectValue | null = null;
    let inventory: Map<string, ObjectValue> | undefined;
    if (current?.id || current?.name) {
      ({ application, inventory } = await this.locateOwnedApplication(current.id, spec.name));
    } else {
      // No recorded creation intent: the name must still be free.
      inventory = await this.applications();
      if ([...inventory.values()].some((entry) => entry.name === spec.name)) {
        throw new Error(
          `A Cloudflare Access application named ${spec.name} exists without a recorded Void creation intent.`,
        );
      }
    }
    const body = this.applicationBody(spec);
    if (application) {
      const id = text(application.id, 'application id');
      application = object(
        await this.request(`apps/${encodeURIComponent(id)}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        }),
        'updated Access application',
      );
      if (text(application.id, 'application id') !== id) {
        throw new Error('Cloudflare returned a different Access application id.');
      }
    } else {
      application = object(
        await this.request('apps', { method: 'POST', body: JSON.stringify(body) }),
        'created Access application',
      );
      const id = text(application.id, 'application id');
      if (inventory?.has(id)) {
        throw new Error('Cloudflare reused an existing Access application id.');
      }
    }
    return this.verifyApplication(application, spec);
  }

  async inspectApplication(
    application: ManagedAccessApplication,
    spec: AccessApplicationSpec,
  ): Promise<{
    present: boolean;
    drifted: boolean;
  }> {
    try {
      const current = object(
        await this.request(`apps/${encodeURIComponent(application.id)}`),
        'Access application',
      );
      return {
        present: true,
        drifted:
          current.name !== application.name ||
          current.aud !== application.audience ||
          applicationConfigurationDrift(current, spec),
      };
    } catch (error) {
      if (error instanceof ZeroTrustCloudflareError && error.status === 404) {
        return { present: false, drifted: true };
      }
      throw error;
    }
  }

  async deleteApplication(
    id: string | null | undefined,
    expectedName?: string | null,
  ): Promise<void> {
    if (!id && !expectedName) {
      return;
    }
    const { application } = await this.locateOwnedApplication(id, expectedName);
    if (!application) {
      return;
    }
    const resolvedId = text(application.id, 'application id');
    try {
      await this.request(`apps/${encodeURIComponent(resolvedId)}`, { method: 'DELETE' });
    } catch (error) {
      if (!(error instanceof ZeroTrustCloudflareError && error.status === 404)) {
        throw error;
      }
    }
  }
}

export function reusablePolicyReferences(policyIds: ReadonlyArray<string>) {
  return policyIds.map((id, index) => ({ id, precedence: index + 1 }));
}

export function bypassPolicy(name: string): ReadonlyArray<ObjectValue> {
  return [
    {
      name,
      decision: 'bypass',
      precedence: 1,
      include: [{ everyone: {} }],
    },
  ];
}

/**
 * The bypass that keeps platform health probes outside project Access. It
 * covers only `/health` (and, as Access matches paths, its subpaths) on the
 * health hostname; every other path there stays under the wildcard application.
 */
export function healthCheckApplication(name: string, hostname: string): AccessApplicationSpec {
  return {
    name,
    destinations: [`${hostname}/health`],
    policies: bypassPolicy('Void platform health check'),
  };
}
