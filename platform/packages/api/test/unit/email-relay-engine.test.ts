import { describe, it, expect, vi } from 'vite-plus/test';
import { OAuthGrantError } from '../../src/email/cf-customer.ts';
import type {
  CfCatchAllRule,
  CfCustomerClient,
  CfSendingSubdomain,
} from '../../src/email/cf-customer.ts';
import {
  RELAY_WORKER_BASE_NAME,
  removeEmailDomain,
  setupEmailDomain,
  syncEmailDomain,
} from '../../src/email/relay-engine.ts';
import type { RelayEngineDeps } from '../../src/email/relay-engine.ts';
import {
  RELAY_COMPATIBILITY_DATE,
  RELAY_SOURCE,
  RELAY_VERSION,
} from '../../src/email/relay-worker.ts';
import { CloudflareApiError } from '../../src/provisioning/cloudflare-api.ts';

// Dummy stand-ins — never real token/secret material.
const CREDENTIAL = 'cf-credential-dummy';
const RELAY_SECRET = 'relay-secret-dummy';
const PROXY_ORIGIN = 'https://proxy.example.test';

type ZoneFixture = { id: string; name: string; accountId: string };

type FakeClientConfig = Readonly<{
  zones?: Record<string, ZoneFixture | undefined>;
  verifyStatus?: string;
  scriptNamesTaken?: ReadonlyArray<string>;
  /** The zone's current catch-all rule; absent/null → 404 (no rule). */
  catchAll?: CfCatchAllRule | null;
  /** GET email/routing's raw result; default { enabled: true }. */
  routingSettings?: unknown;
  /** The sending-subdomain list; default []. */
  sendingSubdomains?: ReadonlyArray<CfSendingSubdomain>;
  failOn?: Partial<Record<string, Error>>;
}>;

type RecordedCall = { method: string; args: ReadonlyArray<unknown> };

function makeFakeClient(config: FakeClientConfig = {}): {
  client: CfCustomerClient;
  calls: Array<RecordedCall>;
} {
  const calls: Array<RecordedCall> = [];
  const maybeThrow = (method: string) => {
    const error = config.failOn?.[method];
    if (error) {
      throw error;
    }
  };
  const record =
    (method: string) =>
    (...args: ReadonlyArray<unknown>) => {
      calls.push({ method, args });
      maybeThrow(method);
    };
  const client: CfCustomerClient = {
    verifyToken: async () => {
      record('verifyToken')();
      return { id: 'tok_1', status: config.verifyStatus ?? 'active', expires_on: null };
    },
    findZone: async (name: string) => {
      record('findZone')(name);
      const zone = config.zones?.[name];
      return zone ? { id: zone.id, name: zone.name, account: { id: zone.accountId } } : null;
    },
    enableRouting: async (zoneId: string, name?: string) => record('enableRouting')(zoneId, name),
    onboardSending: async (zoneId: string, name: string) => record('onboardSending')(zoneId, name),
    listSendingSubdomains: async (zoneId: string) => {
      record('listSendingSubdomains')(zoneId);
      return config.sendingSubdomains ?? [];
    },
    relayScriptExists: async (accountId: string, scriptName: string) => {
      record('relayScriptExists')(accountId, scriptName);
      return config.scriptNamesTaken?.includes(scriptName) ?? false;
    },
    putRelayScript: async (accountId: string, scriptName: string, upload: unknown) =>
      record('putRelayScript')(accountId, scriptName, upload),
    putRelaySecret: async (accountId: string, scriptName: string, secret: string) =>
      record('putRelaySecret')(accountId, scriptName, secret),
    setCatchAll: async (zoneId: string, relayWorkerName: string) =>
      record('setCatchAll')(zoneId, relayWorkerName),
    getCatchAll: async (zoneId: string) => {
      record('getCatchAll')(zoneId);
      return config.catchAll ?? null;
    },
    getRoutingSettings: async (zoneId: string) => {
      record('getRoutingSettings')(zoneId);
      return config.routingSettings ?? { enabled: true };
    },
    resetCatchAll: async (zoneId: string) => record('resetCatchAll')(zoneId),
    deleteRelayScript: async (accountId: string, scriptName: string) =>
      record('deleteRelayScript')(accountId, scriptName),
    sendRaw: async () => {
      throw new Error('sendRaw is the proxy-side send path — the engine never calls it');
    },
  };
  return { client, calls };
}

function methods(calls: Array<RecordedCall>): Array<string> {
  return calls.map((call) => call.method);
}

function depsFor(
  client: CfCustomerClient,
  extra?: Partial<RelayEngineDeps> & { seenCredentials?: Array<string> },
): RelayEngineDeps {
  return {
    createClient: (credential: string) => {
      extra?.seenCredentials?.push(credential);
      return client;
    },
    lookupMx: async () => [],
    // The name-walk's DB reservation — required whenever the row carries
    // no relay name. Tests that exercise 'taken' pass their own.
    claimRelayName: async () => 'claimed',
    ...extra,
  };
}

const ZONE: ZoneFixture = { id: 'zone_1', name: 'acme.com', accountId: 'acct_1' };

function setupInput(domain = 'acme.com') {
  return {
    row: { domain, credential_kind: 'api_token' as const },
    credential: CREDENTIAL,
    relaySecret: RELAY_SECRET,
    proxyOrigin: PROXY_ORIGIN,
  };
}

describe('setupEmailDomain', () => {
  it('runs the contract-7 step order for an apex domain and returns the active row fields', async () => {
    const { client, calls } = makeFakeClient({ zones: { 'acme.com': ZONE } });

    const result = await setupEmailDomain(setupInput(), depsFor(client));

    expect(result).toEqual({
      status: 'active',
      zone_id: 'zone_1',
      account_id: 'acct_1',
      mode: 'apex',
      relay_worker_name: RELAY_WORKER_BASE_NAME,
      relay_version: RELAY_VERSION,
      token_id: 'tok_1',
      token_expires_on: null,
      setup_state: null,
    });
    expect(methods(calls)).toEqual([
      'verifyToken',
      'findZone',
      'enableRouting',
      'onboardSending',
      'relayScriptExists',
      'putRelayScript',
      'putRelaySecret',
      'getCatchAll',
      'setCatchAll',
    ]);
    // Apex enable: empty body (no name argument).
    expect(calls[2].args).toEqual(['zone_1', undefined]);
    expect(calls[5].args).toEqual([
      'acct_1',
      RELAY_WORKER_BASE_NAME,
      {
        source: RELAY_SOURCE,
        compatibilityDate: RELAY_COMPATIBILITY_DATE,
        proxyOrigin: PROXY_ORIGIN,
        emailDomain: 'acme.com',
      },
    ]);
    expect(calls[6].args).toEqual(['acct_1', RELAY_WORKER_BASE_NAME, RELAY_SECRET]);
    // The ownership read precedes the write.
    expect(calls[7].args).toEqual(['zone_1']);
    expect(calls[8].args).toEqual(['zone_1', RELAY_WORKER_BASE_NAME]);
  });

  it('walks the labels up to the registrable zone and takes the subdomain path', async () => {
    const { client, calls } = makeFakeClient({ zones: { 'acme.com': ZONE } });

    const result = await setupEmailDomain(setupInput('mail.acme.com'), depsFor(client));

    expect(result.status).toBe('active');
    expect(result.mode).toBe('subdomain');
    expect(calls.filter((c) => c.method === 'findZone').map((c) => c.args[0])).toEqual([
      'mail.acme.com',
      'acme.com',
    ]);
    // Subdomain enable: POST routing/dns with { name }.
    expect(calls.find((c) => c.method === 'enableRouting')?.args).toEqual([
      'zone_1',
      'mail.acme.com',
    ]);
  });

  it('fails at verify_credential when the token is not active', async () => {
    const { client, calls } = makeFakeClient({ verifyStatus: 'disabled' });

    const result = await setupEmailDomain(setupInput(), depsFor(client));

    expect(result.status).toBe('token_revoked');
    expect(result.setup_state).toEqual({ failed_step: 'verify_credential' });
    expect(methods(calls)).toEqual(['verifyToken']);
  });

  it('maps an expired token to token_expired', async () => {
    const { client } = makeFakeClient({ verifyStatus: 'expired' });

    const result = await setupEmailDomain(setupInput(), depsFor(client));

    expect(result.status).toBe('token_expired');
    expect(result.setup_state).toEqual({ failed_step: 'verify_credential' });
  });

  it('fails at zone_lookup when no suffix of the domain is a visible zone', async () => {
    const { client, calls } = makeFakeClient({ zones: {} });

    const result = await setupEmailDomain(setupInput('mail.acme.com'), depsFor(client));

    expect(result.status).toBe('failed');
    expect(result.setup_state).toEqual({ failed_step: 'zone_lookup' });
    expect(result.error).toContain('mail.acme.com');
    expect(calls.filter((c) => c.method === 'findZone').map((c) => c.args[0])).toEqual([
      'mail.acme.com',
      'acme.com',
    ]);
    expect(methods(calls)).not.toContain('enableRouting');
  });

  it('fails at mx_check when the domain already carries MX, naming the exchanges', async () => {
    const { client, calls } = makeFakeClient({ zones: { 'acme.com': ZONE } });

    const result = await setupEmailDomain(setupInput(), {
      ...depsFor(client),
      lookupMx: async () => ['aspmx.l.google.com'],
    });

    expect(result.status).toBe('failed');
    expect(result.setup_state).toEqual({ failed_step: 'mx_check' });
    expect(result.error).toContain('aspmx.l.google.com');
    expect(result.error).toContain('mail.acme.com');
    // Partial progress is still returned for the row.
    expect(result.zone_id).toBe('zone_1');
    expect(result.account_id).toBe('acct_1');
    expect(methods(calls)).not.toContain('enableRouting');
  });

  it('fails hard when the apex routing POST fails', async () => {
    const { client, calls } = makeFakeClient({
      zones: { 'acme.com': ZONE },
      failOn: { enableRouting: new CloudflareApiError('Cloudflare API error: forbidden', 403) },
    });

    const result = await setupEmailDomain(setupInput(), depsFor(client));

    expect(result.status).toBe('failed');
    expect(result.setup_state).toEqual({ failed_step: 'enable_routing' });
    expect(result.error).toContain('forbidden');
    expect(methods(calls)).not.toContain('onboardSending');
  });

  it('records the human dashboard step when the subdomain routing POST fails, and finishes the rest', async () => {
    const { client, calls } = makeFakeClient({
      zones: { 'acme.com': ZONE },
      failOn: { enableRouting: new CloudflareApiError('Cloudflare API error: forbidden', 403) },
    });

    const result = await setupEmailDomain(setupInput('mail.acme.com'), depsFor(client));

    expect(result.status).toBe('pending');
    expect(result.setup_state).toEqual({ remaining_steps: ['routing_subdomain'] });
    expect(result.relay_worker_name).toBe(RELAY_WORKER_BASE_NAME);
    // Everything after the refused POST still ran.
    expect(methods(calls)).toEqual([
      'verifyToken',
      'findZone',
      'findZone',
      'enableRouting',
      'onboardSending',
      'relayScriptExists',
      'putRelayScript',
      'putRelaySecret',
      'getCatchAll',
      'setCatchAll',
    ]);
  });

  it('keeps the recorded human step on setup_state when a later step fails', async () => {
    const { client } = makeFakeClient({
      zones: { 'acme.com': ZONE },
      failOn: {
        enableRouting: new CloudflareApiError('Cloudflare API error: forbidden', 403),
        onboardSending: new CloudflareApiError('Cloudflare API error: no sending scope', 403),
      },
    });

    const result = await setupEmailDomain(setupInput('mail.acme.com'), depsFor(client));

    expect(result.status).toBe('failed');
    expect(result.setup_state).toEqual({
      failed_step: 'onboard_sending',
      remaining_steps: ['routing_subdomain'],
    });
  });

  it('continues past a Workers Free sending-onboarding refusal — inbound deploys, the step is recorded', async () => {
    const { client, calls } = makeFakeClient({
      zones: { 'acme.com': ZONE },
      failOn: {
        onboardSending: new CloudflareApiError(
          'Cloudflare API error: account is not entitled to Email Sending',
          403,
          [10105],
        ),
      },
    });

    const result = await setupEmailDomain(setupInput(), depsFor(client));

    // Email Routing needs no paid plan, so the relay and catch-all still
    // deploy and the row goes ACTIVE — only the outbound lane stays
    // refused at CF until a plan upgrade.
    expect(result.status).toBe('active');
    expect(result.setup_state).toEqual({ remaining_steps: ['sending_onboarding'] });
    expect(result.relay_worker_name).toBe(RELAY_WORKER_BASE_NAME);
    expect(methods(calls)).toEqual([
      'verifyToken',
      'findZone',
      'enableRouting',
      'onboardSending',
      'relayScriptExists',
      'putRelayScript',
      'putRelaySecret',
      'getCatchAll',
      'setCatchAll',
    ]);
  });

  it('holds the row pending when a Free-plan refusal combines with the routing-subdomain step', async () => {
    const { client } = makeFakeClient({
      zones: { 'acme.com': ZONE },
      failOn: {
        enableRouting: new CloudflareApiError('Cloudflare API error: forbidden', 403),
        onboardSending: new CloudflareApiError(
          'Cloudflare API error: account is not entitled to Email Sending',
          400,
          [2036],
        ),
      },
    });

    const result = await setupEmailDomain(setupInput('mail.acme.com'), depsFor(client));

    // routing_subdomain is inbound-blocking; sending_onboarding is not.
    expect(result.status).toBe('pending');
    expect(result.setup_state).toEqual({
      remaining_steps: ['routing_subdomain', 'sending_onboarding'],
    });
    expect(result.relay_worker_name).toBe(RELAY_WORKER_BASE_NAME);
  });

  it('fails at deploy_relay when the secret PUT fails, after the script upload succeeded — and records the relay name', async () => {
    const { client } = makeFakeClient({
      zones: { 'acme.com': ZONE },
      failOn: { putRelaySecret: new CloudflareApiError('Cloudflare API error: quota', 400) },
    });

    const result = await setupEmailDomain(setupInput(), depsFor(client));

    expect(result.status).toBe('failed');
    expect(result.setup_state).toEqual({ failed_step: 'deploy_relay' });
    // The upload already happened, so the chosen name is recorded even on
    // the failure: a retry redeploys in place instead of leaking this
    // worker and walking to '-2', and a remove can find it.
    expect(result.relay_worker_name).toBe(RELAY_WORKER_BASE_NAME);
    expect(result.relay_version).toBeNull();
  });

  it('fails at deploy_relay with no relay name when every name is taken', async () => {
    const { client } = makeFakeClient({
      zones: { 'acme.com': ZONE },
      scriptNamesTaken: Array.from({ length: 50 }, (_, i) =>
        i === 0 ? RELAY_WORKER_BASE_NAME : `${RELAY_WORKER_BASE_NAME}-${i + 1}`,
      ),
    });

    const result = await setupEmailDomain(setupInput(), depsFor(client));

    expect(result.status).toBe('failed');
    expect(result.setup_state).toEqual({ failed_step: 'deploy_relay' });
    // Nothing was uploaded, so there is no name to record.
    expect(result.relay_worker_name).toBeNull();
    expect(result.relay_version).toBeNull();
  });

  it('fails at catch_all when the catch-all PUT fails', async () => {
    const { client } = makeFakeClient({
      zones: { 'acme.com': ZONE },
      failOn: { setCatchAll: new CloudflareApiError('Cloudflare API error: rules quota', 400) },
    });

    const result = await setupEmailDomain(setupInput(), depsFor(client));

    expect(result.status).toBe('failed');
    expect(result.setup_state).toEqual({ failed_step: 'catch_all' });
    // The relay did get deployed — the row keeps its name for repair.
    expect(result.relay_worker_name).toBe(RELAY_WORKER_BASE_NAME);
  });

  it('suffixes the relay name on collision within the account', async () => {
    const { client, calls } = makeFakeClient({
      zones: { 'acme.com': ZONE },
      scriptNamesTaken: [RELAY_WORKER_BASE_NAME, `${RELAY_WORKER_BASE_NAME}-2`],
    });

    const result = await setupEmailDomain(setupInput(), depsFor(client));

    expect(result.status).toBe('active');
    expect(result.relay_worker_name).toBe(`${RELAY_WORKER_BASE_NAME}-3`);
    expect(calls.filter((c) => c.method === 'relayScriptExists').map((c) => c.args[1])).toEqual([
      RELAY_WORKER_BASE_NAME,
      `${RELAY_WORKER_BASE_NAME}-2`,
      `${RELAY_WORKER_BASE_NAME}-3`,
    ]);
    expect(calls.find((c) => c.method === 'setCatchAll')?.args).toEqual([
      'zone_1',
      `${RELAY_WORKER_BASE_NAME}-3`,
    ]);
  });

  it('walks past a CF-free name the claim reports taken, and never uploads to it', async () => {
    // CF shows only the base name physically present; another ROW holds
    // '-2' in the db — the claim is what skips it, not the CF probe.
    const { client, calls } = makeFakeClient({
      zones: { 'acme.com': ZONE },
      scriptNamesTaken: [RELAY_WORKER_BASE_NAME],
    });
    const claimed: Array<string> = [];

    const result = await setupEmailDomain(
      setupInput(),
      depsFor(client, {
        claimRelayName: async (_accountId, candidate) => {
          claimed.push(candidate);
          return candidate === `${RELAY_WORKER_BASE_NAME}-2` ? 'taken' : 'claimed';
        },
      }),
    );

    expect(result.status).toBe('active');
    expect(result.relay_worker_name).toBe(`${RELAY_WORKER_BASE_NAME}-3`);
    // The base name was CF-taken, so its claim was never spent.
    expect(claimed).toEqual([`${RELAY_WORKER_BASE_NAME}-2`, `${RELAY_WORKER_BASE_NAME}-3`]);
    // The contested name was never written.
    for (const method of ['putRelayScript', 'putRelaySecret'] as const) {
      expect(calls.filter((c) => c.method === method).map((c) => c.args[1])).toEqual([
        `${RELAY_WORKER_BASE_NAME}-3`,
      ]);
    }
  });

  it('fails at deploy_relay when every CF-free name is claim-taken', async () => {
    const { client } = makeFakeClient({ zones: { 'acme.com': ZONE } });

    const result = await setupEmailDomain(
      setupInput(),
      depsFor(client, { claimRelayName: async () => 'taken' }),
    );

    expect(result.status).toBe('failed');
    expect(result.setup_state).toEqual({ failed_step: 'deploy_relay' });
    // Nothing was uploaded, so there is no name to record.
    expect(result.relay_worker_name).toBeNull();
  });

  it('fails at deploy_relay when the walk runs without the claimRelayName dep', async () => {
    // The dep is REQUIRED on the walk: a CF-only probe would silently
    // re-open the last-write-wins relay race, so the walk refuses loudly.
    const { client, calls } = makeFakeClient({ zones: { 'acme.com': ZONE } });

    const result = await setupEmailDomain(setupInput(), {
      ...depsFor(client),
      claimRelayName: undefined,
    });

    expect(result.status).toBe('failed');
    expect(result.setup_state).toEqual({ failed_step: 'deploy_relay' });
    expect(result.error).toContain('claimRelayName');
    // The refusal precedes even the CF probe — nothing was walked or written.
    expect(methods(calls)).not.toContain('relayScriptExists');
    expect(methods(calls)).not.toContain('putRelayScript');
  });

  it('verifies an oauth_grant with one refresh round-trip and returns the rotated refresh token', async () => {
    const { client, calls } = makeFakeClient({ zones: { 'acme.com': ZONE } });
    const seenCredentials: Array<string> = [];
    const refreshed: Array<string> = [];

    const result = await setupEmailDomain(
      { ...setupInput(), row: { domain: 'acme.com', credential_kind: 'oauth_grant' } },
      depsFor(client, {
        seenCredentials,
        refreshGrant: async (refreshToken: string) => {
          refreshed.push(refreshToken);
          return { accessToken: 'cf-access-dummy', refreshToken: 'cf-rotated-dummy' };
        },
      }),
    );

    expect(result.status).toBe('active');
    expect(result.rotated_refresh_token).toBe('cf-rotated-dummy');
    // The grant path has no /user/tokens/verify — token_id stays null.
    expect(result.token_id).toBeNull();
    expect(methods(calls)).not.toContain('verifyToken');
    // Every customer call rode the fresh access token, never the refresh token.
    expect(seenCredentials).toEqual(['cf-access-dummy']);
    expect(refreshed).toEqual([CREDENTIAL]);
  });

  it('maps invalid_grant to token_revoked and still runs no customer calls', async () => {
    const { client, calls } = makeFakeClient({ zones: { 'acme.com': ZONE } });

    const result = await setupEmailDomain(
      { ...setupInput(), row: { domain: 'acme.com', credential_kind: 'oauth_grant' } },
      depsFor(client, {
        refreshGrant: async () => {
          throw new OAuthGrantError('invalid_grant', 400);
        },
      }),
    );

    expect(result.status).toBe('token_revoked');
    expect(result.setup_state).toEqual({ failed_step: 'verify_credential' });
    expect(calls).toEqual([]);
  });

  it('maps a transient OAuth failure to failed, not token_revoked', async () => {
    const { client } = makeFakeClient({ zones: { 'acme.com': ZONE } });

    const result = await setupEmailDomain(
      { ...setupInput(), row: { domain: 'acme.com', credential_kind: 'oauth_grant' } },
      depsFor(client, {
        refreshGrant: async () => {
          throw new OAuthGrantError('temporarily_unavailable', 503);
        },
      }),
    );

    expect(result.status).toBe('failed');
    expect(result.setup_state).toEqual({ failed_step: 'verify_credential' });
  });

  it('returns the rotated refresh token even when a later step fails', async () => {
    // Single-use rotation: dropping the rotated value would kill the chain.
    const { client } = makeFakeClient({
      zones: { 'acme.com': ZONE },
      failOn: { setCatchAll: new CloudflareApiError('Cloudflare API error: quota', 400) },
    });

    const result = await setupEmailDomain(
      { ...setupInput(), row: { domain: 'acme.com', credential_kind: 'oauth_grant' } },
      depsFor(client, {
        refreshGrant: async () => ({
          accessToken: 'cf-access-dummy',
          refreshToken: 'cf-rotated-dummy',
        }),
      }),
    );

    expect(result.status).toBe('failed');
    expect(result.setup_state).toEqual({ failed_step: 'catch_all' });
    expect(result.rotated_refresh_token).toBe('cf-rotated-dummy');
  });

  it('fails at catch_all when the zone catch-all already routes to another worker', async () => {
    // The catch-all is zone-scoped with no domain parameter: overwriting
    // it would hijack the other worker's (possibly another Void domain's)
    // inbound.
    const { client, calls } = makeFakeClient({
      zones: { 'acme.com': ZONE },
      catchAll: { enabled: true, workerName: 'someone-elses-worker' },
    });

    const result = await setupEmailDomain(setupInput(), depsFor(client));

    expect(result.status).toBe('failed');
    expect(result.setup_state).toEqual({ failed_step: 'catch_all' });
    expect(result.error).toContain('someone-elses-worker');
    // The relay still deployed — the row keeps its name for repair — but
    // the conflicting rule was never overwritten.
    expect(result.relay_worker_name).toBe(RELAY_WORKER_BASE_NAME);
    expect(methods(calls)).not.toContain('setCatchAll');
  });

  it('fails at catch_all when the zone catch-all is enabled with a non-worker action', async () => {
    const { client, calls } = makeFakeClient({
      zones: { 'acme.com': ZONE },
      catchAll: { enabled: true, workerName: null },
    });

    const result = await setupEmailDomain(setupInput(), depsFor(client));

    expect(result.status).toBe('failed');
    expect(result.setup_state).toEqual({ failed_step: 'catch_all' });
    expect(result.error).toContain('non-worker');
    expect(methods(calls)).not.toContain('setCatchAll');
  });

  it('overwrites a disabled catch-all, whatever it names', async () => {
    const { client, calls } = makeFakeClient({
      zones: { 'acme.com': ZONE },
      catchAll: { enabled: false, workerName: 'someone-elses-worker' },
    });

    const result = await setupEmailDomain(setupInput(), depsFor(client));

    expect(result.status).toBe('active');
    expect(calls.find((c) => c.method === 'setCatchAll')?.args).toEqual([
      'zone_1',
      RELAY_WORKER_BASE_NAME,
    ]);
  });

  it('re-runs against recorded progress: no MX check, in-place relay, already-done 4xx believed on read-back', async () => {
    const { client, calls } = makeFakeClient({
      zones: { 'acme.com': ZONE },
      routingSettings: { enabled: true, status: 'ready' },
      sendingSubdomains: [{ name: 'acme.com', enabled: true }],
      failOn: {
        enableRouting: new CloudflareApiError('Cloudflare API error: already enabled', 400),
        onboardSending: new CloudflareApiError('Cloudflare API error: already exists', 409),
      },
    });
    const lookupMx = vi.fn(async (): Promise<ReadonlyArray<string>> => {
      throw new Error('the MX check must be skipped on a re-run — our own MX is there now');
    });

    const result = await setupEmailDomain(
      {
        ...setupInput(),
        row: {
          domain: 'acme.com',
          credential_kind: 'api_token',
          mode: 'apex',
          relay_worker_name: RELAY_WORKER_BASE_NAME,
        },
      },
      depsFor(client, { lookupMx }),
    );

    expect(result.status).toBe('active');
    expect(lookupMx).not.toHaveBeenCalled();
    // In-place redeploy: no name-walk, the recorded name is reused.
    expect(methods(calls)).not.toContain('relayScriptExists');
    expect(calls.find((c) => c.method === 'putRelayScript')?.args[1]).toBe(RELAY_WORKER_BASE_NAME);
    // Both 4xx were tolerated only after their read-backs confirmed.
    expect(methods(calls)).toContain('getRoutingSettings');
    expect(methods(calls)).toContain('listSendingSubdomains');
    expect(methods(calls)).toContain('setCatchAll');
  });

  it('fails at enable_routing when a 400 is not confirmed by the settings read-back', async () => {
    const { client } = makeFakeClient({
      zones: { 'acme.com': ZONE },
      routingSettings: { enabled: false, status: 'unconfigured' },
      failOn: {
        enableRouting: new CloudflareApiError('Cloudflare API error: bad request', 400),
      },
    });

    const result = await setupEmailDomain(
      { ...setupInput(), row: { domain: 'acme.com', credential_kind: 'api_token', mode: 'apex' } },
      depsFor(client),
    );

    expect(result.status).toBe('failed');
    expect(result.setup_state).toEqual({ failed_step: 'enable_routing' });
    expect(result.error).toContain('bad request');
  });

  it('fails at onboard_sending when a 409 is not confirmed by the subdomain read-back', async () => {
    const { client } = makeFakeClient({
      zones: { 'acme.com': ZONE },
      failOn: {
        onboardSending: new CloudflareApiError('Cloudflare API error: conflict', 409),
      },
    });

    const result = await setupEmailDomain(
      { ...setupInput(), row: { domain: 'acme.com', credential_kind: 'api_token', mode: 'apex' } },
      depsFor(client),
    );

    expect(result.status).toBe('failed');
    expect(result.setup_state).toEqual({ failed_step: 'onboard_sending' });
    expect(result.error).toContain('conflict');
  });

  it('skips the catch-all write on a re-run whose rule already names the relay', async () => {
    const { client, calls } = makeFakeClient({
      zones: { 'acme.com': ZONE },
      catchAll: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
    });

    const result = await setupEmailDomain(
      {
        ...setupInput(),
        row: {
          domain: 'acme.com',
          credential_kind: 'api_token',
          mode: 'apex',
          relay_worker_name: RELAY_WORKER_BASE_NAME,
        },
      },
      depsFor(client),
    );

    expect(result.status).toBe('active');
    expect(methods(calls)).toContain('getCatchAll');
    expect(methods(calls)).not.toContain('setCatchAll');
  });

  it('a re-run that fails at verify_credential still returns the recorded progress', async () => {
    const { client, calls } = makeFakeClient({ verifyStatus: 'disabled' });

    const result = await setupEmailDomain(
      {
        ...setupInput(),
        row: {
          domain: 'acme.com',
          credential_kind: 'api_token',
          mode: 'apex',
          relay_worker_name: RELAY_WORKER_BASE_NAME,
          zone_id: 'zone_1',
          account_id: 'acct_1',
        },
      },
      depsFor(client),
    );

    expect(result.status).toBe('token_revoked');
    expect(result.setup_state).toEqual({ failed_step: 'verify_credential' });
    // The early failure must not erase what the row already learned.
    expect(result.zone_id).toBe('zone_1');
    expect(result.account_id).toBe('acct_1');
    expect(result.mode).toBe('apex');
    expect(result.relay_worker_name).toBe(RELAY_WORKER_BASE_NAME);
    expect(methods(calls)).toEqual(['verifyToken']);
  });

  it('a re-run that fails at deploy_relay still returns the recorded relay name', async () => {
    const { client, calls } = makeFakeClient({
      zones: { 'acme.com': ZONE },
      failOn: { putRelayScript: new CloudflareApiError('Cloudflare API error: 503', 503) },
    });

    const result = await setupEmailDomain(
      {
        ...setupInput(),
        row: {
          domain: 'acme.com',
          credential_kind: 'api_token',
          mode: 'apex',
          relay_worker_name: RELAY_WORKER_BASE_NAME,
        },
      },
      depsFor(client),
    );

    expect(result.status).toBe('failed');
    expect(result.setup_state).toEqual({ failed_step: 'deploy_relay' });
    // The recorded name survives the failed in-place redeploy, along with
    // the zone/account the lookup re-learned.
    expect(result.relay_worker_name).toBe(RELAY_WORKER_BASE_NAME);
    expect(result.zone_id).toBe('zone_1');
    expect(result.account_id).toBe('acct_1');
    // In-place redeploy: no name-walk.
    expect(methods(calls)).not.toContain('relayScriptExists');
    expect(calls.find((c) => c.method === 'putRelayScript')?.args[1]).toBe(RELAY_WORKER_BASE_NAME);
  });

  it('checkpoints the learned progress once, after the secret PUT and before the catch-all read', async () => {
    const { client, calls } = makeFakeClient({
      zones: { 'acme.com': ZONE },
      scriptNamesTaken: [RELAY_WORKER_BASE_NAME],
    });
    const persisted: Array<unknown> = [];

    const result = await setupEmailDomain(
      setupInput(),
      depsFor(client, {
        persistProgress: async (progress) => {
          // Fires after the relay deploy + secret PUT, before the catch-all.
          expect(methods(calls)).toEqual([
            'verifyToken',
            'findZone',
            'enableRouting',
            'onboardSending',
            'relayScriptExists',
            'relayScriptExists',
            'putRelayScript',
            'putRelaySecret',
          ]);
          persisted.push(progress);
        },
      }),
    );

    expect(result.status).toBe('active');
    // The walked name and the learned zone/account/mode.
    expect(persisted).toEqual([
      {
        zone_id: 'zone_1',
        account_id: 'acct_1',
        mode: 'apex',
        relay_worker_name: `${RELAY_WORKER_BASE_NAME}-2`,
      },
    ]);
    // The catch-all read/write followed the checkpoint.
    expect(methods(calls).slice(-2)).toEqual(['getCatchAll', 'setCatchAll']);
  });

  it('skips the checkpoint on an in-place redeploy — the row already knows', async () => {
    const { client } = makeFakeClient({ zones: { 'acme.com': ZONE } });
    const persistProgress = vi.fn(async () => {});

    const result = await setupEmailDomain(
      {
        ...setupInput(),
        row: {
          domain: 'acme.com',
          credential_kind: 'api_token',
          mode: 'apex',
          relay_worker_name: RELAY_WORKER_BASE_NAME,
        },
      },
      depsFor(client, { persistProgress }),
    );

    expect(result.status).toBe('active');
    expect(persistProgress).not.toHaveBeenCalled();
  });

  it('propagates a persistProgress throw and never touches the catch-all', async () => {
    const { client, calls } = makeFakeClient({ zones: { 'acme.com': ZONE } });

    await expect(
      setupEmailDomain(
        setupInput(),
        depsFor(client, {
          persistProgress: async () => {
            throw new Error('db write failed');
          },
        }),
      ),
    ).rejects.toThrow('db write failed');

    // The deploy succeeded, but no catch-all call happened after the throw.
    expect(methods(calls)).toContain('putRelaySecret');
    expect(methods(calls)).not.toContain('getCatchAll');
    expect(methods(calls)).not.toContain('setCatchAll');
  });

  it('never fires the checkpoint when the deploy itself fails', async () => {
    const { client } = makeFakeClient({
      zones: { 'acme.com': ZONE },
      failOn: { putRelaySecret: new CloudflareApiError('Cloudflare API error: quota', 400) },
    });
    const persistProgress = vi.fn(async () => {});

    const result = await setupEmailDomain(setupInput(), depsFor(client, { persistProgress }));

    expect(result.status).toBe('failed');
    expect(result.setup_state).toEqual({ failed_step: 'deploy_relay' });
    expect(persistProgress).not.toHaveBeenCalled();
  });
});

describe('syncEmailDomain', () => {
  const syncInput = {
    row: {
      domain: 'acme.com',
      credential_kind: 'api_token' as const,
      account_id: 'acct_1',
      relay_worker_name: RELAY_WORKER_BASE_NAME,
    },
    credential: CREDENTIAL,
    proxyOrigin: PROXY_ORIGIN,
  };

  it('redeploys in place at RELAY_VERSION and rotates the secret — no zone, MX, or rule calls', async () => {
    const { client, calls } = makeFakeClient();

    const result = await syncEmailDomain(syncInput, {
      ...depsFor(client),
      generateRelaySecret: () => 'relay-secret-rotated-dummy',
    });

    expect(result).toEqual({
      status: 'active',
      relay_version: RELAY_VERSION,
      setup_state: null,
      new_relay_secret: 'relay-secret-rotated-dummy',
    });
    expect(methods(calls)).toEqual(['verifyToken', 'putRelayScript', 'putRelaySecret']);
    expect(calls[1].args[1]).toBe(RELAY_WORKER_BASE_NAME);
    expect(calls[2].args).toEqual(['acct_1', RELAY_WORKER_BASE_NAME, 'relay-secret-rotated-dummy']);
  });

  it('fails without CF calls when the relay was never deployed', async () => {
    const { client, calls } = makeFakeClient();

    const result = await syncEmailDomain(
      { ...syncInput, row: { ...syncInput.row, relay_worker_name: null } },
      depsFor(client),
    );

    expect(result.status).toBe('failed');
    expect(result.setup_state).toEqual({ failed_step: 'deploy_relay' });
    expect(calls).toEqual([]);
  });

  it('fails at deploy_relay when the redeploy fails, without returning a new secret', async () => {
    const { client } = makeFakeClient({
      failOn: { putRelayScript: new CloudflareApiError('Cloudflare API error: 503', 503) },
    });

    const result = await syncEmailDomain(syncInput, depsFor(client));

    expect(result.status).toBe('failed');
    expect(result.setup_state).toEqual({ failed_step: 'deploy_relay' });
    expect(result.new_relay_secret).toBeUndefined();
  });

  it('ensures a missing catch-all after the redeploy, reporting ensured', async () => {
    const { client, calls } = makeFakeClient();

    const result = await syncEmailDomain(
      { ...syncInput, row: { ...syncInput.row, zone_id: 'zone_1' } },
      { ...depsFor(client), generateRelaySecret: () => 'relay-secret-rotated-dummy' },
    );

    expect(result).toEqual({
      status: 'active',
      relay_version: RELAY_VERSION,
      setup_state: null,
      catch_all: 'ensured',
      new_relay_secret: 'relay-secret-rotated-dummy',
    });
    // The ensure runs after the redeploy + secret PUT.
    expect(methods(calls)).toEqual([
      'verifyToken',
      'putRelayScript',
      'putRelaySecret',
      'getCatchAll',
      'setCatchAll',
    ]);
    expect(calls.at(-1)?.args).toEqual(['zone_1', RELAY_WORKER_BASE_NAME]);
  });

  it('re-points a disabled catch-all at the relay', async () => {
    const { client, calls } = makeFakeClient({
      catchAll: { enabled: false, workerName: 'someone-elses-worker' },
    });

    const result = await syncEmailDomain(
      { ...syncInput, row: { ...syncInput.row, zone_id: 'zone_1' } },
      depsFor(client),
    );

    expect(result.status).toBe('active');
    expect(result.catch_all).toBe('ensured');
    expect(calls.find((c) => c.method === 'setCatchAll')?.args).toEqual([
      'zone_1',
      RELAY_WORKER_BASE_NAME,
    ]);
  });

  it('leaves an enabled catch-all already naming the relay untouched', async () => {
    const { client, calls } = makeFakeClient({
      catchAll: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
    });

    const result = await syncEmailDomain(
      { ...syncInput, row: { ...syncInput.row, zone_id: 'zone_1' } },
      depsFor(client),
    );

    expect(result.status).toBe('active');
    expect(result.catch_all).toBe('already_set');
    expect(methods(calls)).not.toContain('setCatchAll');
  });

  it('never overwrites an enabled catch-all naming a different worker — report, do not fight', async () => {
    const { client, calls } = makeFakeClient({
      catchAll: { enabled: true, workerName: 'someone-elses-worker' },
    });

    const result = await syncEmailDomain(
      { ...syncInput, row: { ...syncInput.row, zone_id: 'zone_1' } },
      depsFor(client),
    );

    // The redeploy/rotation still succeeded — only the conflict is reported.
    expect(result.status).toBe('active');
    expect(result.catch_all).toBe('foreign_conflict');
    expect(result.new_relay_secret).toBeDefined();
    expect(methods(calls)).not.toContain('setCatchAll');
  });

  it('reports probe_failed when the ownership read throws, and still succeeds', async () => {
    const { client } = makeFakeClient({
      failOn: { getCatchAll: new CloudflareApiError('Cloudflare API error: 500', 500) },
    });

    const result = await syncEmailDomain(
      { ...syncInput, row: { ...syncInput.row, zone_id: 'zone_1' } },
      depsFor(client),
    );

    expect(result.status).toBe('active');
    expect(result.catch_all).toBe('probe_failed');
    expect(result.new_relay_secret).toBeDefined();
  });

  it('re-attempts a pending sending onboarding after the catch-all ensure, reporting it cleared', async () => {
    const { client, calls } = makeFakeClient({
      catchAll: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
    });

    const result = await syncEmailDomain(
      {
        ...syncInput,
        row: {
          ...syncInput.row,
          zone_id: 'zone_1',
          setup_remaining_steps: ['sending_onboarding'],
        },
      },
      depsFor(client),
    );

    expect(result.status).toBe('active');
    expect(result.cleared_steps).toEqual(['sending_onboarding']);
    // The retry runs after the redeploy, rotation, and catch-all ensure.
    expect(methods(calls)).toEqual([
      'verifyToken',
      'putRelayScript',
      'putRelaySecret',
      'getCatchAll',
      'onboardSending',
    ]);
  });

  it('keeps the step when the onboarding retry is refused again, without failing the sync', async () => {
    const { client } = makeFakeClient({
      catchAll: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
      failOn: {
        onboardSending: new CloudflareApiError(
          'Cloudflare API error: account is not entitled to Email Sending',
          403,
          [10105],
        ),
      },
    });

    const result = await syncEmailDomain(
      {
        ...syncInput,
        row: {
          ...syncInput.row,
          zone_id: 'zone_1',
          setup_remaining_steps: ['sending_onboarding'],
        },
      },
      depsFor(client),
    );

    expect(result.status).toBe('active');
    expect(result.catch_all).toBe('already_set');
    expect(result.cleared_steps).toBeUndefined();
    expect(result.new_relay_secret).toBeDefined();
  });

  it('clears the step on a confirming read-back behind a 409', async () => {
    const { client } = makeFakeClient({
      catchAll: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
      sendingSubdomains: [{ name: 'acme.com', enabled: true }],
      failOn: {
        onboardSending: new CloudflareApiError('Cloudflare API error: already onboarded', 409),
      },
    });

    const result = await syncEmailDomain(
      {
        ...syncInput,
        row: {
          ...syncInput.row,
          zone_id: 'zone_1',
          setup_remaining_steps: ['sending_onboarding'],
        },
      },
      depsFor(client),
    );

    expect(result.status).toBe('active');
    expect(result.cleared_steps).toEqual(['sending_onboarding']);
  });

  it('makes no sending-onboarding call when the row carries no such step', async () => {
    const { client, calls } = makeFakeClient({
      catchAll: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
    });

    const result = await syncEmailDomain(
      {
        ...syncInput,
        row: {
          ...syncInput.row,
          zone_id: 'zone_1',
          setup_remaining_steps: ['routing_subdomain'],
        },
      },
      depsFor(client),
    );

    expect(result.status).toBe('active');
    expect(result.cleared_steps).toBeUndefined();
    expect(methods(calls)).not.toContain('onboardSending');
  });

  it('makes no catch-all calls when the row carries no zone_id, and omits the field', async () => {
    const { client, calls } = makeFakeClient();

    const result = await syncEmailDomain(
      { ...syncInput, row: { ...syncInput.row, zone_id: null } },
      { ...depsFor(client), generateRelaySecret: () => 'relay-secret-rotated-dummy' },
    );

    expect(result).toEqual({
      status: 'active',
      relay_version: RELAY_VERSION,
      setup_state: null,
      new_relay_secret: 'relay-secret-rotated-dummy',
    });
    expect(methods(calls)).toEqual(['verifyToken', 'putRelayScript', 'putRelaySecret']);
  });
});

describe('removeEmailDomain', () => {
  const removeInput = {
    row: {
      credential_kind: 'api_token' as const,
      account_id: 'acct_1',
      relay_worker_name: RELAY_WORKER_BASE_NAME,
      zone_id: 'zone_1',
    },
    credential: CREDENTIAL,
  };

  it('resets the catch-all it still owns, then deletes the relay script — best-effort, no verify round-trip', async () => {
    const { client, calls } = makeFakeClient({
      catchAll: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
    });

    const result = await removeEmailDomain(removeInput, depsFor(client));

    expect(result.failed_steps).toEqual([]);
    expect(methods(calls)).toEqual(['getCatchAll', 'resetCatchAll', 'deleteRelayScript']);
    expect(calls[0].args).toEqual(['zone_1']);
    expect(calls[1].args).toEqual(['zone_1']);
    expect(calls[2].args).toEqual(['acct_1', RELAY_WORKER_BASE_NAME]);
  });

  it('reports delete_relay when the relay delete fails after the catch-all reset ran', async () => {
    const { client, calls } = makeFakeClient({
      catchAll: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
      failOn: { deleteRelayScript: new CloudflareApiError('Cloudflare API error: 500', 500) },
    });

    const result = await removeEmailDomain(removeInput, depsFor(client));

    expect(result.failed_steps).toEqual(['delete_relay']);
    expect(methods(calls)).toEqual(['getCatchAll', 'resetCatchAll', 'deleteRelayScript']);
  });

  it('refreshes an oauth_grant for cleanup and reports both steps failed when the grant is dead', async () => {
    const { client, calls } = makeFakeClient();

    const result = await removeEmailDomain(
      { ...removeInput, row: { ...removeInput.row, credential_kind: 'oauth_grant' } },
      depsFor(client, {
        refreshGrant: async () => {
          throw new OAuthGrantError('invalid_grant', 400);
        },
      }),
    );

    expect(result.failed_steps).toEqual(['delete_relay', 'catch_all']);
    expect(calls).toEqual([]);
  });

  it('skips CF calls the row never reached', async () => {
    const { client, calls } = makeFakeClient();

    const result = await removeEmailDomain(
      {
        ...removeInput,
        row: { ...removeInput.row, account_id: null, relay_worker_name: null, zone_id: null },
      },
      depsFor(client),
    );

    expect(result.failed_steps).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('leaves a catch-all naming another worker untouched', async () => {
    const { client, calls } = makeFakeClient({
      catchAll: { enabled: true, workerName: 'someone-elses-worker' },
    });

    const result = await removeEmailDomain(removeInput, depsFor(client));

    expect(result.failed_steps).toEqual([]);
    expect(methods(calls)).toEqual(['getCatchAll', 'deleteRelayScript']);
  });

  it('leaves a disabled catch-all untouched even when it names our relay', async () => {
    const { client, calls } = makeFakeClient({
      catchAll: { enabled: false, workerName: RELAY_WORKER_BASE_NAME },
    });

    const result = await removeEmailDomain(removeInput, depsFor(client));

    expect(result.failed_steps).toEqual([]);
    expect(methods(calls)).toEqual(['getCatchAll', 'deleteRelayScript']);
  });

  it('keeps rule and relay as a pair when the ownership read fails', async () => {
    const { client, calls } = makeFakeClient({
      failOn: { getCatchAll: new CloudflareApiError('Cloudflare API error: 500', 500) },
    });

    const result = await removeEmailDomain(removeInput, depsFor(client));

    // The delete is never attempted: an enabled catch-all must not be left
    // pointing at a deleted worker, so both steps report failed.
    expect(result.failed_steps).toEqual(['catch_all', 'delete_relay']);
    expect(methods(calls)).toEqual(['getCatchAll']);
  });

  it('keeps the relay when the catch-all reset fails — the enabled rule never points at a deleted worker', async () => {
    const { client, calls } = makeFakeClient({
      catchAll: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
      failOn: { resetCatchAll: new CloudflareApiError('Cloudflare API error: 500', 500) },
    });

    const result = await removeEmailDomain(removeInput, depsFor(client));

    expect(result.failed_steps).toEqual(['catch_all', 'delete_relay']);
    expect(methods(calls)).toEqual(['getCatchAll', 'resetCatchAll']);
  });

  it('never reads the catch-all when the relay never deployed, even with a known zone', async () => {
    const { client, calls } = makeFakeClient();

    const result = await removeEmailDomain(
      { ...removeInput, row: { ...removeInput.row, relay_worker_name: null } },
      depsFor(client),
    );

    expect(result.failed_steps).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('repoints an owned catch-all at the winning relay when the target exists, re-checking after the PUT', async () => {
    const { client, calls } = makeFakeClient({
      catchAll: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
      scriptNamesTaken: ['winning-relay'],
    });

    const result = await removeEmailDomain(
      { ...removeInput, repoint_catch_all_to: 'winning-relay' },
      depsFor(client),
    );

    expect(result.failed_steps).toEqual([]);
    expect(methods(calls)).toEqual([
      'getCatchAll',
      'relayScriptExists',
      'setCatchAll',
      // Post-check: the winner may have been deleted mid-compensation.
      'relayScriptExists',
      'deleteRelayScript',
    ]);
    expect(calls.filter((c) => c.method === 'relayScriptExists').map((c) => c.args)).toEqual([
      ['acct_1', 'winning-relay'],
      ['acct_1', 'winning-relay'],
    ]);
    expect(calls.find((c) => c.method === 'setCatchAll')?.args).toEqual([
      'zone_1',
      'winning-relay',
    ]);
    expect(methods(calls)).not.toContain('resetCatchAll');
  });

  it('falls back to the reset when the repoint target does not exist', async () => {
    const { client, calls } = makeFakeClient({
      catchAll: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
    });

    const result = await removeEmailDomain(
      { ...removeInput, repoint_catch_all_to: 'winning-relay' },
      depsFor(client),
    );

    expect(result.failed_steps).toEqual([]);
    expect(methods(calls)).toEqual([
      'getCatchAll',
      'relayScriptExists',
      'resetCatchAll',
      'deleteRelayScript',
    ]);
    expect(methods(calls)).not.toContain('setCatchAll');
  });

  it('keeps the rule-and-relay pair when the repoint PUT fails', async () => {
    const { client, calls } = makeFakeClient({
      catchAll: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
      scriptNamesTaken: ['winning-relay'],
      failOn: { setCatchAll: new CloudflareApiError('Cloudflare API error: 500', 500) },
    });

    const result = await removeEmailDomain(
      { ...removeInput, repoint_catch_all_to: 'winning-relay' },
      depsFor(client),
    );

    expect(result.failed_steps).toEqual(['catch_all', 'delete_relay']);
    expect(methods(calls)).toEqual(['getCatchAll', 'relayScriptExists', 'setCatchAll']);
    expect(methods(calls)).not.toContain('deleteRelayScript');
  });

  it('takes the plain reset path when the repoint target names the row’s own relay', async () => {
    const { client, calls } = makeFakeClient({
      catchAll: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
    });

    const result = await removeEmailDomain(
      { ...removeInput, repoint_catch_all_to: RELAY_WORKER_BASE_NAME },
      depsFor(client),
    );

    expect(result.failed_steps).toEqual([]);
    expect(methods(calls)).toEqual(['getCatchAll', 'resetCatchAll', 'deleteRelayScript']);
    expect(methods(calls)).not.toContain('relayScriptExists');
  });

  it('revokes the grant after the CF cleanup when the refresh succeeded', async () => {
    const { client, calls } = makeFakeClient({
      catchAll: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
    });
    const refreshed: Array<string> = [];
    let revoked = 0;

    const result = await removeEmailDomain(
      { ...removeInput, row: { ...removeInput.row, credential_kind: 'oauth_grant' } },
      depsFor(client, {
        refreshGrant: async (refreshToken: string) => {
          refreshed.push(refreshToken);
          // The refresh precedes every customer call.
          expect(calls).toEqual([]);
          return { accessToken: 'cf-access-dummy', refreshToken: 'cf-rotated-dummy' };
        },
        // Zero-arg: the dep revokes the row's LIVE chain head; which token
        // that is belongs to the serialized helper, not the engine.
        revokeGrant: async () => {
          revoked += 1;
          // Revocation is the LAST step — the CF cleanup already ran.
          expect(methods(calls)).toEqual(['getCatchAll', 'resetCatchAll', 'deleteRelayScript']);
        },
      }),
    );

    expect(result.failed_steps).toEqual([]);
    expect(refreshed).toEqual([CREDENTIAL]);
    expect(revoked).toBe(1);
  });

  it("appends 'revoke_grant' to failed_steps when the revocation rejects, without throwing", async () => {
    const { client } = makeFakeClient({
      catchAll: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
    });

    const result = await removeEmailDomain(
      { ...removeInput, row: { ...removeInput.row, credential_kind: 'oauth_grant' } },
      depsFor(client, {
        refreshGrant: async () => ({
          accessToken: 'cf-access-dummy',
          refreshToken: 'cf-rotated-dummy',
        }),
        revokeGrant: async () => {
          throw new Error('network down');
        },
      }),
    );

    expect(result.failed_steps).toEqual(['revoke_grant']);
  });

  it('skips the revocation when the refresh fails with invalid_grant — the grant is already dead', async () => {
    const { client, calls } = makeFakeClient();
    const revokeGrant = vi.fn(async () => {});

    const result = await removeEmailDomain(
      { ...removeInput, row: { ...removeInput.row, credential_kind: 'oauth_grant' } },
      depsFor(client, {
        refreshGrant: async () => {
          throw new OAuthGrantError('invalid_grant', 400);
        },
        revokeGrant,
      }),
    );

    expect(result.failed_steps).toEqual(['delete_relay', 'catch_all']);
    expect(revokeGrant).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('revokes when the refresh fails transiently — the stored token may still be live', async () => {
    const { client, calls } = makeFakeClient();
    let revoked = 0;

    const result = await removeEmailDomain(
      { ...removeInput, row: { ...removeInput.row, credential_kind: 'oauth_grant' } },
      depsFor(client, {
        refreshGrant: async () => {
          throw new OAuthGrantError('temporarily_unavailable', 503);
        },
        revokeGrant: async () => {
          revoked += 1;
        },
      }),
    );

    // The early-return shape is unchanged.
    expect(result.failed_steps).toEqual(['delete_relay', 'catch_all']);
    expect(revoked).toBe(1);
    expect(calls).toEqual([]);
  });

  it('never revokes an api_token row, even with the dep', async () => {
    const { client } = makeFakeClient({
      catchAll: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
    });
    const revokeGrant = vi.fn(async () => {});

    const result = await removeEmailDomain(removeInput, depsFor(client, { revokeGrant }));

    expect(result.failed_steps).toEqual([]);
    expect(revokeGrant).not.toHaveBeenCalled();
  });

  it('runs the oauth cleanup without any revocation when no revokeGrant dep is supplied', async () => {
    // Deliberate: the conflict-compensation caller leaves its row alive,
    // so it passes no dep and the credential keeps working.
    const { client, calls } = makeFakeClient({
      catchAll: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
    });

    const result = await removeEmailDomain(
      { ...removeInput, row: { ...removeInput.row, credential_kind: 'oauth_grant' } },
      depsFor(client, {
        refreshGrant: async () => ({
          accessToken: 'cf-access-dummy',
          refreshToken: 'cf-rotated-dummy',
        }),
      }),
    );

    expect(result.failed_steps).toEqual([]);
    expect(methods(calls)).toEqual(['getCatchAll', 'resetCatchAll', 'deleteRelayScript']);
  });
});
