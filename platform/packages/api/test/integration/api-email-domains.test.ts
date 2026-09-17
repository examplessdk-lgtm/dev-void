/**
 * Control-plane coverage for custom email domains on the customer's own
 * Cloudflare zone (design doc 0078, "Custom domains on Cloudflare").
 *
 * Routes under test (mounted in `src/index.ts`):
 *   - `GET    /projects/:id/email/domains`
 *   - `POST   /projects/:id/email/domains`
 *   - `GET    /projects/:id/email/domains/:domain`
 *   - `POST   /projects/:id/email/domains/:domain/sync`
 *   - `DELETE /projects/:id/email/domains/:domain`
 *   - `POST   /internal/email/domain-credential`  (the proxy's lease)
 *
 * The CF calls go to the CUSTOMER's account with the customer's credential,
 * so the platform-wide `mockCfApi` helper does not cover them — this file
 * stubs fetch itself (`stubCustomerCf`), including the OAuth token endpoint
 * (dash.cloudflare.com) and the public-DNS MX lookup (cloudflare-dns.com).
 *
 * All credential-shaped strings are dummy stand-ins, never real material.
 * Secret-shaped request bodies are recorded by SHAPE (name/type/length),
 * never by value, and no response may contain a credential fixture.
 */

import { eq, sql } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vite-plus/test';
import { hmacSignState } from '../../src/auth/hmac.ts';
import {
  leaseEmailDomainCredential,
  refreshOauthGrantSerialized,
} from '../../src/email/credential-lease.ts';
import {
  decryptEmailDomainRelaySecret,
  decryptEmailDomainToken,
  encryptEmailDomainRelaySecret,
  encryptEmailDomainToken,
  hashEmailRelaySecret,
  markEmailDomainRemovalFailed,
  writeEmailDomainMirror,
} from '../../src/email/domains.ts';
import type { EmailDomain } from '../../src/email/domains.ts';
import { RELAY_WORKER_BASE_NAME } from '../../src/email/relay-engine.ts';
import {
  RELAY_COMPATIBILITY_DATE,
  RELAY_EMAIL_DOMAIN_BINDING,
  RELAY_PROXY_ORIGIN_BINDING,
  RELAY_SECRET_BINDING,
  RELAY_VERSION,
} from '../../src/email/relay-worker.ts';
import app from '../../src/index.ts';
import { emailDomains, projects } from '../../src/schema.ts';
import {
  cfError,
  cfSuccess,
  clearTables,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
  JWT_SECRET,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;

// Dummy stand-ins — never real token/secret material.
const API_TOKEN = 'cf-api-token-dummy';
const API_TOKEN_REPLACEMENT = 'cf-api-token-replacement-dummy';
const REFRESH_TOKEN = 'cf-refresh-token-dummy';
const RELAY_SECRET = 'relay-secret-dummy';
const ZONE = { id: 'zone_1', name: 'acme.com', accountId: 'acct_1' };

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
  // ROUTING is file-scoped — sweep this suite's mirror keys so tests don't
  // leak mirror state into each other.
  const mirrors = await env.ROUTING.list({ prefix: 'email-domain:' });
  await Promise.all(mirrors.keys.map((key) => env.ROUTING.delete(key.name)));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Customer-side CF/OAuth/DNS fetch stub
// ---------------------------------------------------------------------------

type StubFailTag =
  | 'verifyToken'
  | 'zones'
  | 'mxLookup'
  | 'routingDns'
  | 'onboardSending'
  | 'sendingSubdomainsGet'
  | 'scriptGet'
  | 'scriptPut'
  | 'secretPut'
  | 'catchAll'
  | 'catchAllGet'
  | 'routingSettingsGet'
  | 'scriptDelete'
  | 'oauthToken'
  | 'oauthRevoke';

type RecordedCall = {
  tag: StubFailTag;
  method: string;
  url: string;
  /** Parsed JSON body for string bodies; parsed metadata for the script PUT. */
  body?: unknown;
  /** OAuth token-endpoint form fields, minus nothing — dummy fixtures only. */
  form?: Record<string, string>;
  /** Secrets PUT shape: name/type/text shape — never the text itself. */
  secret?: { name: string; type: string; textShape: string };
};

function stubCustomerCf(
  config: {
    zones?: Record<string, { id: string; name: string; accountId: string }>;
    verifyStatus?: string;
    verifyExpiresOn?: string | null;
    mx?: Record<string, Array<string>>;
    existingScripts?: ReadonlyArray<string>;
    /**
     * Initial catch-all state, applied to every zone. Absent → CF's real
     * default for a zone that never had a rule written: a DISABLED drop
     * rule (live probes). `null` → no rule at all (CF 404). GET/PUT then
     * keep mutating the per-zone state.
     */
    catchAllRule?: { enabled: boolean; workerName: string | null } | null;
    /** GET email/routing's result; default { enabled: true }. */
    routingSettings?: Record<string, unknown>;
    /** GET sending/subdomains entries; default []. */
    sendingSubdomains?: ReadonlyArray<{ name: string; enabled: boolean }>;
    failOn?: Partial<Record<StubFailTag, { message: string; status: number; code?: number }>>;
    /** Side-effect hook fired right after a call is recorded (mid-request seams). */
    on?: Partial<Record<StubFailTag, () => void | Promise<void>>>;
    oauth?: 'rotate' | 'invalid_grant' | 'server_error';
  } = {},
) {
  const calls: Array<RecordedCall> = [];
  let oauthRound = 0;
  const fail = (tag: StubFailTag): Response | null => {
    const failure = config.failOn?.[tag];
    return failure ? cfError(failure.message, failure.status, failure.code) : null;
  };
  const record = async (call: RecordedCall): Promise<void> => {
    calls.push(call);
    await config.on?.[call.tag]?.();
  };

  // Per-zone catch-all rule state, lazily seeded from the config.
  const catchAllStates = new Map<string, { enabled: boolean; workerName: string | null } | null>();
  const catchAllStateFor = (zoneId: string) => {
    if (!catchAllStates.has(zoneId)) {
      catchAllStates.set(
        zoneId,
        config.catchAllRule === undefined || config.catchAllRule === null
          ? config.catchAllRule === null
            ? null
            : { enabled: false, workerName: null }
          : { ...config.catchAllRule },
      );
    }
    return catchAllStates.get(zoneId)!;
  };

  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';

    if (url.startsWith('https://dash.cloudflare.com/oauth2/token')) {
      const form: Record<string, string> = {};
      if (typeof init?.body === 'string') {
        for (const [key, value] of new URLSearchParams(init.body)) {
          form[key] = value;
        }
      }
      await record({ tag: 'oauthToken', method, url, form });
      const failure = fail('oauthToken');
      if (failure) {
        return failure;
      }
      if (config.oauth === 'invalid_grant') {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      if (config.oauth === 'server_error') {
        return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
      }
      // Chain off the incoming token so the rotation survives stub resets:
      // a presented `cf-rotated-refresh-dummy-N` rotates to N+1, anything
      // else (the originally posted grant) starts at 1.
      const roundMatch = /^cf-rotated-refresh-dummy-(\d+)$/.exec(form.refresh_token ?? '');
      oauthRound = roundMatch ? Number(roundMatch[1]) + 1 : 1;
      return Response.json({
        access_token: `cf-access-dummy-${oauthRound}`,
        refresh_token: `cf-rotated-refresh-dummy-${oauthRound}`,
        expires_in: 3600,
      });
    }

    if (url.startsWith('https://dash.cloudflare.com/oauth2/revoke')) {
      const form: Record<string, string> = {};
      if (typeof init?.body === 'string') {
        for (const [key, value] of new URLSearchParams(init.body)) {
          form[key] = value;
        }
      }
      await record({ tag: 'oauthRevoke', method, url, form });
      // RFC 7009 answers 200 whether the token was revoked or already
      // invalid; the body is ignored.
      return fail('oauthRevoke') ?? new Response(null, { status: 200 });
    }

    if (url.startsWith('https://cloudflare-dns.com/dns-query')) {
      await record({ tag: 'mxLookup', method, url });
      const failure = fail('mxLookup');
      if (failure) {
        return failure;
      }
      const name = new URL(url).searchParams.get('name') ?? '';
      const exchanges = config.mx?.[name] ?? [];
      return Response.json({
        Answer: exchanges.map((exchange) => ({ type: 15, data: `10 ${exchange}.` })),
      });
    }

    if (!url.startsWith('https://api.cloudflare.com/client/v4/')) {
      throw new Error(`Unmocked fetch: ${method} ${url}`);
    }
    const path = url.slice('https://api.cloudflare.com/client/v4'.length);

    if (path === '/user/tokens/verify') {
      await record({ tag: 'verifyToken', method, url });
      const failure = fail('verifyToken');
      if (failure) {
        return failure;
      }
      return cfSuccess({
        id: 'tok_dummy',
        status: config.verifyStatus ?? 'active',
        expires_on: config.verifyExpiresOn ?? null,
      });
    }

    if (path.startsWith('/zones?')) {
      await record({ tag: 'zones', method, url });
      const failure = fail('zones');
      if (failure) {
        return failure;
      }
      const name = new URL(url).searchParams.get('name') ?? '';
      const zone = config.zones?.[name];
      return cfSuccess(
        zone ? [{ id: zone.id, name: zone.name, account: { id: zone.accountId } }] : [],
      );
    }

    if (path.includes('/email/routing/dns') && method === 'POST') {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      await record({ tag: 'routingDns', method, url, body });
      return fail('routingDns') ?? cfSuccess({});
    }

    if (path.includes('/email/sending/subdomains') && method === 'POST') {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      await record({ tag: 'onboardSending', method, url, body });
      return fail('onboardSending') ?? cfSuccess({});
    }

    if (path.includes('/email/sending/subdomains') && method === 'GET') {
      await record({ tag: 'sendingSubdomainsGet', method, url });
      const failure = fail('sendingSubdomainsGet');
      if (failure) {
        return failure;
      }
      return cfSuccess(config.sendingSubdomains ?? []);
    }

    // The settings GET is anchored at the exact path — /email/routing/dns
    // and /email/routing/rules/... must not match it.
    if (/\/zones\/[^/]+\/email\/routing$/.test(path) && method === 'GET') {
      await record({ tag: 'routingSettingsGet', method, url });
      const failure = fail('routingSettingsGet');
      if (failure) {
        return failure;
      }
      return cfSuccess(config.routingSettings ?? { enabled: true });
    }

    const catchAllMatch = /\/zones\/([^/]+)\/email\/routing\/rules\/catch_all$/.exec(path);
    if (catchAllMatch && method === 'GET') {
      await record({ tag: 'catchAllGet', method, url });
      const failure = fail('catchAllGet');
      if (failure) {
        return failure;
      }
      const state = catchAllStateFor(catchAllMatch[1]!);
      if (state === null) {
        return cfError('rule not found', 404);
      }
      return cfSuccess({
        enabled: state.enabled,
        matchers: [{ type: 'all' }],
        actions:
          state.workerName === null
            ? [{ type: 'drop', value: [] }]
            : [{ type: 'worker', value: [state.workerName] }],
      });
    }

    if (catchAllMatch && method === 'PUT') {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      await record({ tag: 'catchAll', method, url, body });
      const failure = fail('catchAll');
      if (failure) {
        return failure;
      }
      // The write mutates the zone's rule: a worker action names the worker,
      // anything else (the reset's drop) is a disabled non-worker rule.
      const actions = (body as { actions?: Array<{ type: string; value?: Array<string> }> })
        ?.actions;
      const worker = actions?.find((action) => action.type === 'worker');
      catchAllStates.set(catchAllMatch[1]!, {
        enabled: Boolean((body as { enabled?: unknown })?.enabled),
        workerName: worker?.value?.[0] ?? null,
      });
      return cfSuccess({});
    }

    const secretsMatch = /\/workers\/scripts\/[^/]+\/secrets$/.exec(path);
    if (secretsMatch && method === 'PUT') {
      const parsed = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      const text = typeof parsed.text === 'string' ? parsed.text : '';
      await record({
        tag: 'secretPut',
        method,
        url,
        secret: {
          name: String(parsed.name),
          type: String(parsed.type),
          // Shape, never the value: length class + alphabet.
          textShape: `len=${text.length} ${/^[A-Za-z0-9_-]+$/.test(text) ? 'base64url' : 'other'}`,
        },
      });
      return fail('secretPut') ?? cfSuccess({});
    }

    const scriptMatch = /\/accounts\/[^/]+\/workers\/scripts\/([^/?#]+)$/.exec(path);
    if (scriptMatch && method === 'GET') {
      await record({ tag: 'scriptGet', method, url });
      const failure = fail('scriptGet');
      if (failure) {
        return failure;
      }
      if (config.existingScripts?.includes(scriptMatch[1]!)) {
        // The raw script GET answers source bytes, not a v4 envelope.
        return new Response('export default {}', { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }
    if (scriptMatch && method === 'PUT') {
      let metadata: unknown;
      if (init?.body instanceof FormData) {
        const metaEntry = init.body.get('metadata');
        if (metaEntry instanceof Blob) {
          metadata = JSON.parse(await metaEntry.text());
        }
      }
      await record({ tag: 'scriptPut', method, url, body: metadata });
      return fail('scriptPut') ?? cfSuccess({});
    }
    if (scriptMatch && method === 'DELETE') {
      await record({ tag: 'scriptDelete', method, url });
      return fail('scriptDelete') ?? cfSuccess({});
    }

    throw new Error(`Unmocked customer fetch: ${method} ${url}`);
  });

  vi.stubGlobal('fetch', fn);
  return { calls, fn, catchAllStates };
}

function callsByTag(calls: Array<RecordedCall>, tag: StubFailTag): Array<RecordedCall> {
  return calls.filter((call) => call.tag === tag);
}

function tags(calls: Array<RecordedCall>): Array<StubFailTag> {
  return calls.map((call) => call.tag);
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function addDomain(projectId: string, jwt: string, body: unknown) {
  return app.fetch(
    new Request(`http://localhost/projects/${projectId}/email/domains`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  );
}

function listDomains(projectId: string, jwt: string) {
  return app.fetch(
    new Request(`http://localhost/projects/${projectId}/email/domains`, {
      headers: { Authorization: `Bearer ${jwt}` },
    }),
    env,
  );
}

function domainStatus(projectId: string, domain: string, jwt: string) {
  return app.fetch(
    new Request(`http://localhost/projects/${projectId}/email/domains/${domain}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    }),
    env,
  );
}

function syncDomain(projectId: string, domain: string, jwt: string) {
  return app.fetch(
    new Request(`http://localhost/projects/${projectId}/email/domains/${domain}/sync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
    }),
    env,
  );
}

function removeDomain(
  projectId: string,
  domain: string,
  jwt: string,
  options?: { force?: boolean },
) {
  return app.fetch(
    new Request(
      `http://localhost/projects/${projectId}/email/domains/${domain}${options?.force ? '?force=1' : ''}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${jwt}` },
      },
    ),
    env,
  );
}

async function leaseCredential(domain: string, signAs?: string) {
  const token = await hmacSignState(signAs ?? domain, JWT_SECRET);
  return app.fetch(
    new Request('http://localhost/internal/email/domain-credential', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-void-internal': token },
      body: JSON.stringify({ domain }),
    }),
    env,
  );
}

function leaseCredentialUnsigned(domain: string) {
  return app.fetch(
    new Request('http://localhost/internal/email/domain-credential', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain }),
    }),
    env,
  );
}

// ---------------------------------------------------------------------------
// Row / mirror helpers
// ---------------------------------------------------------------------------

async function rowFor(projectId: string, domain: string): Promise<EmailDomain | undefined> {
  const rows = await env.db
    .select()
    .from(emailDomains)
    .where(eq(emailDomains.project_id, projectId));
  return rows.find((row) => row.domain === domain);
}

async function mirrorFor(domain: string): Promise<Record<string, unknown> | null> {
  const raw = await env.ROUTING.get(`email-domain:${domain}`);
  return raw === null ? null : (JSON.parse(raw as string) as Record<string, unknown>);
}

/** Seed a row directly (no orchestration), with an optional mirror. */
async function seedEmailDomain(
  projectId: string,
  domain: string,
  options: {
    status: EmailDomain['status'];
    credentialKind?: EmailDomain['credential_kind'];
    credential?: string;
    mirror?: boolean;
    relayWorkerName?: string;
  },
): Promise<EmailDomain> {
  const credentialKind = options.credentialKind ?? 'api_token';
  const tokenEnc = await encryptEmailDomainToken(
    env,
    projectId,
    domain,
    options.credential ?? API_TOKEN,
  );
  const relayEnc = await encryptEmailDomainRelaySecret(env, projectId, domain, RELAY_SECRET);
  const id = `edom_seed_${domain.replace(/[^a-z0-9]/g, '')}`;
  await env.db.insert(emailDomains).values({
    id,
    project_id: projectId,
    domain,
    zone_id: ZONE.id,
    account_id: ZONE.accountId,
    mode: 'apex',
    status: options.status,
    credential_kind: credentialKind,
    token_ciphertext: tokenEnc.ciphertext,
    token_iv: tokenEnc.iv,
    token_key_version: tokenEnc.keyVersion,
    relay_ciphertext: relayEnc.ciphertext,
    relay_iv: relayEnc.iv,
    relay_key_version: relayEnc.keyVersion,
    relay_worker_name: options.relayWorkerName ?? RELAY_WORKER_BASE_NAME,
    relay_version: RELAY_VERSION,
  });
  const row = (await rowFor(projectId, domain))!;
  if (options.mirror !== false) {
    await writeEmailDomainMirror(env.ROUTING, row, await hashEmailRelaySecret(RELAY_SECRET));
  }
  return row;
}

/** Add an active api_token domain through the real route. */
async function addActiveDomain(
  projectId: string,
  jwt: string,
  domain = 'acme.com',
  zones: Record<string, typeof ZONE> = { 'acme.com': ZONE },
) {
  const stub = stubCustomerCf({ zones });
  const res = await addDomain(projectId, jwt, { domain, apiToken: API_TOKEN });
  expect(res.status).toBe(201);
  return stub;
}

// A token_expires_on value only the final apply ever writes (the verify
// stub returns it; the checkpoint never touches the column), so an AFTER
// UPDATE trigger on it fails exactly the apply — with a NON-unique error.
const APPLY_SENTINEL_EXPIRY = '2030-01-01T00:00:00.000Z';

async function installApplySentinelTrigger(): Promise<void> {
  await env.db.execute(
    sql.raw(
      `CREATE OR REPLACE FUNCTION email_apply_sentinel_raise() RETURNS trigger
       LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'email apply sentinel'; END; $$`,
    ),
  );
  await env.db.execute(
    sql.raw(
      // Idempotent: the stub hook fires on EVERY catch-all call, so a test
      // whose compensation resets the rule re-enters this installer.
      `DROP TRIGGER IF EXISTS email_apply_sentinel ON email_domains`,
    ),
  );
  await env.db.execute(
    sql.raw(
      `CREATE TRIGGER email_apply_sentinel AFTER UPDATE ON email_domains
       FOR EACH ROW WHEN (NEW.token_expires_on = '2030-01-01 00:00:00'::timestamp)
       EXECUTE FUNCTION email_apply_sentinel_raise()`,
    ),
  );
}

async function dropApplySentinelTrigger(): Promise<void> {
  await env.db.execute(sql.raw('DROP TRIGGER IF EXISTS email_apply_sentinel ON email_domains'));
  await env.db.execute(sql.raw('DROP FUNCTION IF EXISTS email_apply_sentinel_raise()'));
}

// Same mechanism as the apply sentinel, but firing on the deploy
// CHECKPOINT write instead: relay_worker_name null→non-null happens only
// there (the final apply writes it already-set), so a NON-unique error
// here fails exactly the checkpoint.
async function installCheckpointSentinelTrigger(): Promise<void> {
  await env.db.execute(
    sql.raw(
      `CREATE OR REPLACE FUNCTION email_checkpoint_sentinel_raise() RETURNS trigger
       LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'email checkpoint sentinel'; END; $$`,
    ),
  );
  await env.db.execute(
    sql.raw(`DROP TRIGGER IF EXISTS email_checkpoint_sentinel ON email_domains`),
  );
  await env.db.execute(
    sql.raw(
      `CREATE TRIGGER email_checkpoint_sentinel AFTER UPDATE ON email_domains
       FOR EACH ROW WHEN (OLD.relay_worker_name IS NULL AND NEW.relay_worker_name IS NOT NULL)
       EXECUTE FUNCTION email_checkpoint_sentinel_raise()`,
    ),
  );
}

async function dropCheckpointSentinelTrigger(): Promise<void> {
  await env.db.execute(
    sql.raw('DROP TRIGGER IF EXISTS email_checkpoint_sentinel ON email_domains'),
  );
  await env.db.execute(sql.raw('DROP FUNCTION IF EXISTS email_checkpoint_sentinel_raise()'));
}

// ---------------------------------------------------------------------------
// Owner guard
// ---------------------------------------------------------------------------

describe('email domain routes — owner guard', () => {
  it('401s unauthenticated', async () => {
    const res = await app.fetch(
      new Request('http://localhost/projects/proj_nope/email/domains', { method: 'POST' }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('404s for a nonexistent project', async () => {
    const user = await createTestUser(env.db);
    const res = await addDomain('proj_nope', user.jwt, { domain: 'acme.com', apiToken: API_TOKEN });
    expect(res.status).toBe(404);
  });

  it('403s a non-owner on every domain verb', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const other = await createTestUser(env.db, 'other');
    const project = await createTestProject(env.db, owner.id);
    await seedEmailDomain(project.id, 'acme.com', { status: 'active' });

    const responses = await Promise.all([
      addDomain(project.id, other.jwt, { domain: 'acme.com', apiToken: API_TOKEN }),
      listDomains(project.id, other.jwt),
      domainStatus(project.id, 'acme.com', other.jwt),
      syncDomain(project.id, 'acme.com', other.jwt),
      removeDomain(project.id, 'acme.com', other.jwt),
    ]);
    expect(responses.map((res) => res.status)).toEqual([403, 403, 403, 403, 403]);
    // The non-owner never reached the row or the mirror.
    expect(await rowFor(project.id, 'acme.com')).toBeDefined();
    expect(await mirrorFor('acme.com')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /projects/:id/email/domains
// ---------------------------------------------------------------------------

describe('POST /projects/:id/email/domains', () => {
  it('rejects malformed input before any credential work', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const stub = stubCustomerCf({ zones: { 'acme.com': ZONE } });

    const cases: Array<[unknown, string]> = [
      [{}, 'no domain'],
      [{ domain: 42, apiToken: API_TOKEN }, 'non-string domain'],
      [{ domain: 'not a domain', apiToken: API_TOKEN }, 'invalid shape'],
      [{ domain: 'acme.com' }, 'no credential'],
      [
        { domain: 'acme.com', apiToken: API_TOKEN, refreshToken: REFRESH_TOKEN },
        'both credentials',
      ],
      [{ domain: 'acme.com', apiToken: API_TOKEN, mode: 'weird' }, 'bad mode'],
    ];
    for (const [body, label] of cases) {
      const res = await addDomain(project.id, user.jwt, body);
      expect(res.status, label).toBe(400);
    }
    // Nothing reached CF, nothing was stored.
    expect(stub.calls).toEqual([]);
    expect(await rowFor(project.id, 'acme.com')).toBeUndefined();
  });

  it('adds an apex domain with an api_token — full contract-7 order, encrypted storage, mirror', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const stub = stubCustomerCf({ zones: { 'acme.com': ZONE } });

    const res = await addDomain(project.id, user.jwt, { domain: 'acme.com', apiToken: API_TOKEN });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({
      domain: 'acme.com',
      mode: 'apex',
      status: 'active',
      credential_kind: 'api_token',
      relay_worker_name: RELAY_WORKER_BASE_NAME,
      relay_version: RELAY_VERSION,
      token_id: 'tok_dummy',
      setup_state: null,
    });
    // No ciphertext triples, no credential material in the response.
    const raw = await Promise.resolve(JSON.stringify(json));
    for (const leaked of [API_TOKEN, 'ciphertext', 'relay_ciphertext', 'token_ciphertext']) {
      expect(raw).not.toContain(leaked);
    }

    // The step order is contract 7's: verify → zone → MX → routing →
    // sending → relay deploy (exists → put → secret) → catch-all, with the
    // ownership read ahead of the catch-all write.
    expect(tags(stub.calls)).toEqual([
      'verifyToken',
      'zones',
      'mxLookup',
      'routingDns',
      'onboardSending',
      'scriptGet',
      'scriptPut',
      'secretPut',
      'catchAllGet',
      'catchAll',
    ]);
    // Apex routing enable: empty body.
    expect(callsByTag(stub.calls, 'routingDns')[0]!.body).toBeUndefined();
    expect(callsByTag(stub.calls, 'onboardSending')[0]!.body).toEqual({ name: 'acme.com' });

    // The relay upload declares the two plain-text vars and the module.
    const upload = callsByTag(stub.calls, 'scriptPut')[0]!.body as Record<string, unknown>;
    expect(upload).toMatchObject({
      main_module: 'index.js',
      compatibility_date: RELAY_COMPATIBILITY_DATE,
      bindings: [
        { type: 'plain_text', name: RELAY_PROXY_ORIGIN_BINDING, text: 'https://proxy.void.cloud' },
        { type: 'plain_text', name: RELAY_EMAIL_DOMAIN_BINDING, text: 'acme.com' },
      ],
    });
    // The relay secret goes out as a worker secret — asserted by shape.
    expect(callsByTag(stub.calls, 'secretPut')[0]!.secret).toEqual({
      name: RELAY_SECRET_BINDING,
      type: 'secret_text',
      textShape: 'len=43 base64url',
    });
    // The catch-all names the relay, one action, enabled.
    expect(callsByTag(stub.calls, 'catchAll')[0]!.body).toEqual({
      matchers: [{ type: 'all' }],
      actions: [{ type: 'worker', value: [RELAY_WORKER_BASE_NAME] }],
      enabled: true,
    });

    // Storage: ciphertexts decrypt under the fixed AAD names; the mirror
    // carries the sha256 and no secret material.
    const row = (await rowFor(project.id, 'acme.com'))!;
    expect(await decryptEmailDomainToken(env, project.id, 'acme.com', row)).toBe(API_TOKEN);
    const relaySecret = await decryptEmailDomainRelaySecret(env, project.id, 'acme.com', row);
    const mirror = (await mirrorFor('acme.com'))!;
    expect(mirror).toEqual({
      projectId: project.id,
      status: 'active',
      relaySecretSha256: await hashEmailRelaySecret(relaySecret),
      relayWorkerName: RELAY_WORKER_BASE_NAME,
      accountId: ZONE.accountId,
      zoneId: ZONE.id,
      mode: 'apex',
    });
    expect(JSON.stringify(mirror)).not.toContain(relaySecret);
    expect(JSON.stringify(mirror)).not.toContain(API_TOKEN);
  });

  it('takes the subdomain path when the zone is the parent', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const stub = stubCustomerCf({ zones: { 'acme.com': ZONE } });

    const res = await addDomain(project.id, user.jwt, {
      domain: 'mail.acme.com',
      mode: 'subdomain',
      apiToken: API_TOKEN,
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ domain: 'mail.acme.com', mode: 'subdomain', status: 'active' });
    // Zone lookup walked the labels up.
    expect(callsByTag(stub.calls, 'zones').map((call) => call.url)).toEqual([
      expect.stringContaining('name=mail.acme.com'),
      expect.stringContaining('name=acme.com'),
    ]);
    // Subdomain routing enable carries { name }.
    expect(callsByTag(stub.calls, 'routingDns')[0]!.body).toEqual({ name: 'mail.acme.com' });
  });

  it('stays pending with the human step when the subdomain routing POST is refused', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    stubCustomerCf({
      zones: { 'acme.com': ZONE },
      failOn: { routingDns: { message: 'forbidden', status: 403 } },
    });

    const res = await addDomain(project.id, user.jwt, {
      domain: 'mail.acme.com',
      apiToken: API_TOKEN,
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('pending');
    expect(json.setup_state).toEqual({ remaining_steps: ['routing_subdomain'] });
    // Everything after the refused POST still ran — relay deployed, mirror written.
    expect(json.relay_worker_name).toBe(RELAY_WORKER_BASE_NAME);
    expect((await mirrorFor('mail.acme.com'))!.status).toBe('pending');
  });

  it('completes inbound setup on a Workers Free sending refusal — active, the plan step recorded', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const stub = stubCustomerCf({
      zones: { 'acme.com': ZONE },
      failOn: {
        onboardSending: {
          message: 'account is not entitled to Email Sending',
          status: 403,
          code: 10105,
        },
      },
    });

    const res = await addDomain(project.id, user.jwt, { domain: 'acme.com', apiToken: API_TOKEN });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    // Email Routing needs no paid plan: the relay deployed, the catch-all
    // was written, and the row + mirror are ACTIVE — inbound works. Only
    // the outbound lane stays refused at CF until a plan upgrade.
    expect(json.status).toBe('active');
    expect(json.setup_state).toEqual({ remaining_steps: ['sending_onboarding'] });
    expect(json.relay_worker_name).toBe(RELAY_WORKER_BASE_NAME);
    expect(tags(stub.calls)).toEqual(
      expect.arrayContaining(['onboardSending', 'scriptPut', 'secretPut', 'catchAll']),
    );
    expect((await mirrorFor('acme.com'))!.status).toBe('active');
  });

  it('fails at mx_check when the domain already carries MX', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    stubCustomerCf({
      zones: { 'acme.com': ZONE },
      mx: { 'acme.com': ['aspmx.l.google.com'] },
    });

    const res = await addDomain(project.id, user.jwt, { domain: 'acme.com', apiToken: API_TOKEN });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('failed');
    expect(json.setup_state).toEqual({ failed_step: 'mx_check' });
    expect(String(json.error)).toContain('aspmx.l.google.com');
    // Partial progress is on the row; no routing/sending/relay calls ran.
    const row = (await rowFor(project.id, 'acme.com'))!;
    expect(row.zone_id).toBe(ZONE.id);
    expect(row.account_id).toBe(ZONE.accountId);
    expect(row.relay_worker_name).toBeNull();
    expect((await mirrorFor('acme.com'))!.status).toBe('failed');
  });

  it('records the relay name when the secret PUT fails — a re-add redeploys in place', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    stubCustomerCf({
      zones: { 'acme.com': ZONE },
      failOn: { secretPut: { message: 'quota', status: 400 } },
    });

    const res = await addDomain(project.id, user.jwt, { domain: 'acme.com', apiToken: API_TOKEN });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('failed');
    expect(json.setup_state).toEqual({ failed_step: 'deploy_relay' });

    // The script upload succeeded before the secret PUT failed, so the row
    // records the chosen name — a blind delete would race a concurrent
    // deploy's upsert, and an unrecorded upload would leak the worker and
    // walk the retry to '-2'.
    const failedRow = (await rowFor(project.id, 'acme.com'))!;
    expect(failedRow.relay_worker_name).toBe(RELAY_WORKER_BASE_NAME);
    expect(failedRow.relay_version).toBeNull();

    // The customer fixes the quota and re-adds: the recorded name is
    // redeployed IN PLACE — no name-walk (no scriptGet), no '-2'.
    const stub = stubCustomerCf({ zones: { 'acme.com': ZONE } });
    const retry = await addDomain(project.id, user.jwt, {
      domain: 'acme.com',
      apiToken: API_TOKEN,
    });
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as Record<string, unknown>).status).toBe('active');
    expect(callsByTag(stub.calls, 'scriptGet')).toEqual([]);
    expect(callsByTag(stub.calls, 'scriptPut').map((call) => call.url)).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/${ZONE.accountId}/workers/scripts/${RELAY_WORKER_BASE_NAME}`,
    ]);
    expect((await rowFor(project.id, 'acme.com'))!.relay_worker_name).toBe(RELAY_WORKER_BASE_NAME);
  });

  it('maps a non-active api token to token_revoked at verify_credential', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    stubCustomerCf({ verifyStatus: 'disabled' });

    const res = await addDomain(project.id, user.jwt, { domain: 'acme.com', apiToken: API_TOKEN });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('token_revoked');
    expect(json.setup_state).toEqual({ failed_step: 'verify_credential' });
  });

  it('maps an expired api token to token_expired', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    stubCustomerCf({ verifyStatus: 'expired' });

    const res = await addDomain(project.id, user.jwt, { domain: 'acme.com', apiToken: API_TOKEN });
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('token_expired');
  });

  it('409s when the requested mode contradicts the zone-derived mode', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    stubCustomerCf({ zones: { 'acme.com': ZONE } });

    const res = await addDomain(project.id, user.jwt, {
      domain: 'acme.com',
      mode: 'subdomain',
      apiToken: API_TOKEN,
    });
    expect(res.status).toBe(409);
    // The row records the derived truth.
    const row = (await rowFor(project.id, 'acme.com'))!;
    expect(row.mode).toBe('apex');
    expect(row.status).toBe('active');
  });

  it('409s when the domain is registered to another project — one domain, one project', async () => {
    const user = await createTestUser(env.db);
    const first = await createTestProject(env.db, user.id);
    const second = await createTestProject(env.db, user.id);
    const stub = stubCustomerCf({ zones: { 'acme.com': ZONE } });

    const created = await addDomain(first.id, user.jwt, {
      domain: 'acme.com',
      apiToken: API_TOKEN,
    });
    expect(created.status).toBe(201);
    const callsAfterFirst = stub.calls.length;

    // Same user, second project, same zone credential: a domain maps to
    // exactly one project — the single `email-domain:<domain>` mirror key
    // and relay secret cannot fan out to two.
    const res = await addDomain(second.id, user.jwt, {
      domain: 'acme.com',
      apiToken: API_TOKEN,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      'domain is registered to another project',
    );

    // Nothing reached CF and no row exists for the second project; the
    // first project's row and mirror are untouched.
    expect(stub.calls.length).toBe(callsAfterFirst);
    expect(await rowFor(second.id, 'acme.com')).toBeUndefined();
    expect((await rowFor(first.id, 'acme.com'))!.status).toBe('active');
    expect((await mirrorFor('acme.com'))!.projectId).toBe(first.id);
  });

  it('409s when another live row already claims the zone — the loser is compensated, never activated', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    // Row one is seeded DIRECTLY: a route-registered first domain would
    // leave the stub's catch-all naming its relay, and the second domain's
    // engine run would then fail at its own catch-all precheck instead of
    // reaching the checkpoint (that path is covered by its own test above).
    await seedEmailDomain(project.id, 'acme.com', { status: 'active' });

    // Domain two resolves to the SAME zone; its relay name-walk takes '-2'
    // because the base name is taken in the account. The deploy CHECKPOINT
    // (after the relay deploy, before the catch-all step) is where the zone
    // backstop catches the race — the loser never writes its rule.
    const stub = stubCustomerCf({
      zones: { 'other.com': { ...ZONE, name: 'other.com' } },
      existingScripts: [RELAY_WORKER_BASE_NAME],
    });
    const res = await addDomain(project.id, user.jwt, { domain: 'other.com', apiToken: API_TOKEN });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      'another active email domain already uses this zone — remove it first',
    );

    // Bounded compensation ran from the checkpoint payload: ONE ownership
    // read (the zone's untouched disabled-drop default names no relay, so
    // no reset) and the delete of the SECOND relay — never the first's.
    expect(callsByTag(stub.calls, 'catchAllGet')).toHaveLength(1);
    expect(callsByTag(stub.calls, 'scriptDelete').map((call) => call.url)).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/${ZONE.accountId}/workers/scripts/${RELAY_WORKER_BASE_NAME}-2`,
    ]);
    // The loser NEVER reached its catch-all write — the checkpoint aborts
    // setup first — so the winner's zone rule is byte-identical.
    expect(callsByTag(stub.calls, 'catchAll')).toEqual([]);
    expect(stub.catchAllStates.get(ZONE.id)).toEqual({ enabled: false, workerName: null });

    // Row one is untouched; row two stayed pre-apply and got no mirror.
    expect((await rowFor(project.id, 'acme.com'))!).toMatchObject({
      status: 'active',
      zone_id: ZONE.id,
      account_id: ZONE.accountId,
      relay_worker_name: RELAY_WORKER_BASE_NAME,
    });
    expect((await rowFor(project.id, 'other.com'))!).toMatchObject({
      status: 'pending',
      zone_id: null,
      account_id: null,
      mode: null,
      relay_worker_name: null,
    });
    expect(await mirrorFor('other.com')).toBeNull();
    expect((await mirrorFor('acme.com'))!.projectId).toBe(project.id);
  });

  it('409s when another row already holds the relay name — the contested worker is never deleted', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    // Row one (seeded directly, same reason as the zone race above) already
    // holds 'void-email-relay-2' in the account.
    await seedEmailDomain(project.id, 'acme.com', {
      status: 'active',
      relayWorkerName: `${RELAY_WORKER_BASE_NAME}-2`,
    });

    // Domain two resolves to a DIFFERENT zone in the SAME account. The base
    // name is taken, so the name-walk deploys 'void-email-relay-2' — the
    // name row one holds — and the deploy CHECKPOINT 23505s on the relay
    // index. The stub's zone_2 catch-all already names that relay, so the
    // compensation's conditional reset fires.
    const stub = stubCustomerCf({
      zones: { 'other.com': { id: 'zone_2', name: 'other.com', accountId: ZONE.accountId } },
      existingScripts: [RELAY_WORKER_BASE_NAME],
      catchAllRule: { enabled: true, workerName: `${RELAY_WORKER_BASE_NAME}-2` },
    });
    const res = await addDomain(project.id, user.jwt, { domain: 'other.com', apiToken: API_TOKEN });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      'another email domain is deploying the same relay worker — retry',
    );

    // The contested name is NEVER deleted — no scriptDelete at all. The
    // compensation detaches only the loser's zone rule: ONE ownership read
    // (the checkpoint aborted the engine before its own), and the read
    // named the loser's relay, so the conditional reset (drop, disabled)
    // fired.
    expect(callsByTag(stub.calls, 'scriptDelete')).toEqual([]);
    expect(callsByTag(stub.calls, 'catchAllGet')).toHaveLength(1);
    const catchAllWrites = callsByTag(stub.calls, 'catchAll');
    expect(catchAllWrites).toHaveLength(1);
    expect(catchAllWrites[0]!.url).toBe(
      'https://api.cloudflare.com/client/v4/zones/zone_2/email/routing/rules/catch_all',
    );
    expect(catchAllWrites[0]!.body).toEqual({
      matchers: [{ type: 'all' }],
      actions: [{ type: 'drop' }],
      enabled: false,
    });
    expect(stub.catchAllStates.get('zone_2')).toEqual({ enabled: false, workerName: null });

    // Row one is untouched; row two stayed pre-apply and got no mirror.
    expect((await rowFor(project.id, 'acme.com'))!).toMatchObject({
      status: 'active',
      zone_id: ZONE.id,
      account_id: ZONE.accountId,
      relay_worker_name: `${RELAY_WORKER_BASE_NAME}-2`,
    });
    expect((await rowFor(project.id, 'other.com'))!).toMatchObject({
      status: 'pending',
      zone_id: null,
      account_id: null,
      mode: null,
      relay_worker_name: null,
    });
    expect(await mirrorFor('other.com')).toBeNull();
    expect((await mirrorFor('acme.com'))!.projectId).toBe(project.id);
  });

  it('409s when the project is torn down mid-setup — the checkpoint finds the row gone', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const stub = stubCustomerCf({
      zones: { 'acme.com': ZONE },
      on: {
        // The secret PUT is the CF call immediately before the deploy
        // checkpoint: teardown's cascade removes the email_domains row
        // here, so the checkpoint's UPDATE ... RETURNING finds nothing.
        secretPut: async () => {
          await env.db.delete(projects).where(eq(projects.id, project.id));
        },
      },
    });

    const res = await addDomain(project.id, user.jwt, { domain: 'acme.com', apiToken: API_TOKEN });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('project is being deleted');
    // The abort precedes the catch-all step, and the row is gone — but the
    // relay WAS deployed, so the route compensates from the captured
    // checkpoint (teardown's per-row cleanup can't see it): ONE ownership
    // read (the untouched disabled-drop default names no relay, so no
    // reset) and the relay DELETE.
    expect(callsByTag(stub.calls, 'catchAllGet')).toHaveLength(1);
    expect(callsByTag(stub.calls, 'catchAll')).toEqual([]);
    expect(callsByTag(stub.calls, 'scriptDelete').map((call) => call.url)).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/${ZONE.accountId}/workers/scripts/${RELAY_WORKER_BASE_NAME}`,
    ]);
    expect(await rowFor(project.id, 'acme.com')).toBeUndefined();
    expect(await mirrorFor('acme.com')).toBeNull();
  });

  it('500s when the checkpoint write fails for a non-race reason — and compensates the deployed relay', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const stub = stubCustomerCf({ zones: { 'acme.com': ZONE } });
    await installCheckpointSentinelTrigger();
    let res;
    try {
      res = await addDomain(project.id, user.jwt, { domain: 'acme.com', apiToken: API_TOKEN });
    } finally {
      await dropCheckpointSentinelTrigger();
    }

    // A non-unique checkpoint failure is NOT a race: it propagates.
    expect(res.status).toBe(500);
    // …but only after compensating the relay the rolled-back UPDATE never
    // recorded: ONE ownership read (no reset — the zone's default names no
    // relay) and the relay DELETE.
    expect(callsByTag(stub.calls, 'catchAllGet')).toHaveLength(1);
    expect(callsByTag(stub.calls, 'catchAll')).toEqual([]);
    expect(callsByTag(stub.calls, 'scriptDelete').map((call) => call.url)).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/${ZONE.accountId}/workers/scripts/${RELAY_WORKER_BASE_NAME}`,
    ]);
    // The row carries no reference to the deleted relay.
    expect((await rowFor(project.id, 'acme.com'))!).toMatchObject({
      status: 'pending',
      relay_worker_name: null,
    });
    expect(await mirrorFor('acme.com')).toBeNull();
  });

  it('repoints an owned catch-all at the zone winner when the final apply loses the race', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    // Row A crashed AFTER the checkpoint: 'failed', but carrying its zone
    // and relay. Re-running it deploys in place (no checkpoint), so the
    // zone conflict surfaces only at the FINAL apply — the re-run window.
    await seedEmailDomain(project.id, 'acme.com', {
      status: 'failed',
      relayWorkerName: `${RELAY_WORKER_BASE_NAME}-a`,
    });
    // Row B is the live winner of the same zone.
    await seedEmailDomain(project.id, 'other.com', {
      status: 'active',
      relayWorkerName: `${RELAY_WORKER_BASE_NAME}-b`,
    });

    const stub = stubCustomerCf({
      zones: { 'acme.com': ZONE },
      failOn: {
        routingDns: { message: 'already enabled', status: 400 },
        onboardSending: { message: 'already exists', status: 409 },
      },
      routingSettings: { enabled: true, status: 'ready' },
      sendingSubdomains: [{ name: 'acme.com', enabled: true }],
      // The repoint path proves the winner's relay exists before AND after.
      existingScripts: [`${RELAY_WORKER_BASE_NAME}-b`],
    });
    const res = await addDomain(project.id, user.jwt, {
      domain: 'acme.com',
      apiToken: API_TOKEN_REPLACEMENT,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      'another active email domain already uses this zone — remove it first',
    );

    // The engine wrote A's rule; the compensation REPOINTED it at B's relay
    // instead of resetting — the zone's inbound keeps working for the
    // winner.
    expect(callsByTag(stub.calls, 'catchAllGet')).toHaveLength(2);
    expect(callsByTag(stub.calls, 'catchAll').map((call) => call.body)).toEqual([
      {
        matchers: [{ type: 'all' }],
        actions: [{ type: 'worker', value: [`${RELAY_WORKER_BASE_NAME}-a`] }],
        enabled: true,
      },
      {
        matchers: [{ type: 'all' }],
        actions: [{ type: 'worker', value: [`${RELAY_WORKER_BASE_NAME}-b`] }],
        enabled: true,
      },
    ]);
    expect(stub.catchAllStates.get(ZONE.id)).toEqual({
      enabled: true,
      workerName: `${RELAY_WORKER_BASE_NAME}-b`,
    });
    // A zone race keeps the account id: A's own relay is deleted.
    expect(callsByTag(stub.calls, 'scriptDelete').map((call) => call.url)).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/${ZONE.accountId}/workers/scripts/${RELAY_WORKER_BASE_NAME}-a`,
    ]);

    // A stays exactly as seeded; B is untouched.
    expect((await rowFor(project.id, 'acme.com'))!).toMatchObject({
      status: 'failed',
      zone_id: ZONE.id,
      relay_worker_name: `${RELAY_WORKER_BASE_NAME}-a`,
    });
    expect((await rowFor(project.id, 'other.com'))!).toMatchObject({
      status: 'active',
      zone_id: ZONE.id,
      relay_worker_name: `${RELAY_WORKER_BASE_NAME}-b`,
    });
  });

  it('adds an oauth_grant domain — one refresh round-trip, rotation persisted', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const stub = stubCustomerCf({ zones: { 'acme.com': ZONE } });

    const res = await addDomain(project.id, user.jwt, {
      domain: 'acme.com',
      refreshToken: REFRESH_TOKEN,
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({
      status: 'active',
      credential_kind: 'oauth_grant',
      token_id: null,
    });

    // The refresh ran on wrangler's public client with the posted grant…
    const oauth = callsByTag(stub.calls, 'oauthToken');
    expect(oauth).toHaveLength(1);
    expect(oauth[0]!.form).toEqual({
      grant_type: 'refresh_token',
      client_id: '54d11594-84e4-41aa-b438-e81b8fa78ee7',
      refresh_token: REFRESH_TOKEN,
    });
    // …and every customer call rode the fresh access token, so the grant
    // path never calls /user/tokens/verify.
    expect(callsByTag(stub.calls, 'verifyToken')).toEqual([]);
    // The rotated refresh token replaced the posted one on the row.
    const row = (await rowFor(project.id, 'acme.com'))!;
    expect(await decryptEmailDomainToken(env, project.id, 'acme.com', row)).toBe(
      'cf-rotated-refresh-dummy-1',
    );
    const raw = JSON.stringify(json);
    expect(raw).not.toContain(REFRESH_TOKEN);
    expect(raw).not.toContain('cf-rotated-refresh-dummy-1');
  });

  it('maps invalid_grant on add to token_revoked, mirrored', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const stub = stubCustomerCf({ zones: { 'acme.com': ZONE }, oauth: 'invalid_grant' });

    const res = await addDomain(project.id, user.jwt, {
      domain: 'acme.com',
      refreshToken: REFRESH_TOKEN,
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('token_revoked');
    expect(json.setup_state).toEqual({ failed_step: 'verify_credential' });
    expect(callsByTag(stub.calls, 'zones')).toEqual([]);
    expect((await mirrorFor('acme.com'))!.status).toBe('token_revoked');
  });

  it('re-adds a failed row — the credential is replaced and setup re-runs', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    stubCustomerCf({
      zones: { 'acme.com': ZONE },
      mx: { 'acme.com': ['aspmx.l.google.com'] },
    });
    await addDomain(project.id, user.jwt, { domain: 'acme.com', apiToken: API_TOKEN });
    expect((await rowFor(project.id, 'acme.com'))!.status).toBe('failed');

    // The customer fixes DNS (MX gone) and re-adds with a fresh token.
    stubCustomerCf({ zones: { 'acme.com': ZONE } });
    const res = await addDomain(project.id, user.jwt, {
      domain: 'acme.com',
      apiToken: API_TOKEN_REPLACEMENT,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('active');
    const row = (await rowFor(project.id, 'acme.com'))!;
    expect(await decryptEmailDomainToken(env, project.id, 'acme.com', row)).toBe(
      API_TOKEN_REPLACEMENT,
    );
    expect(row.relay_worker_name).toBe(RELAY_WORKER_BASE_NAME);
  });

  it('re-adds an active row — rules stay, the relay is redeployed and its secret rotated', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await addActiveDomain(project.id, user.jwt);
    const before = await mirrorFor('acme.com');

    const stub = stubCustomerCf({
      zones: { 'acme.com': ZONE },
      catchAllRule: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
    });
    const res = await addDomain(project.id, user.jwt, {
      domain: 'acme.com',
      apiToken: API_TOKEN_REPLACEMENT,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('active');
    expect(json.catch_all).toBe('already_set');

    // The sync path: verify + relay redeploy + secret PUT + the catch-all
    // ensure probe — no zone, MX, routing, or sending calls, and no
    // catch-all WRITE (the rule already names this row's relay).
    expect(tags(stub.calls)).toEqual(['verifyToken', 'scriptPut', 'secretPut', 'catchAllGet']);
    expect(stub.catchAllStates.get(ZONE.id)).toEqual({
      enabled: true,
      workerName: RELAY_WORKER_BASE_NAME,
    });
    const row = (await rowFor(project.id, 'acme.com'))!;
    expect(await decryptEmailDomainToken(env, project.id, 'acme.com', row)).toBe(
      API_TOKEN_REPLACEMENT,
    );
    // Relay name never changes; the mirror's sha256 rotated with the secret.
    expect(row.relay_worker_name).toBe(RELAY_WORKER_BASE_NAME);
    const after = await mirrorFor('acme.com');
    expect(after!.relaySecretSha256).not.toBe(before!.relaySecretSha256);
    expect(after!.status).toBe('active');
  });

  it('re-adds with a dead credential — token_revoked, but the recorded progress is kept', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await addActiveDomain(project.id, user.jwt);
    const before = (await rowFor(project.id, 'acme.com'))!;
    expect(before.status).toBe('active');

    // The replacement token verifies as non-active — the engine fails at
    // verify_credential, before re-learning any lifecycle field.
    stubCustomerCf({ verifyStatus: 'disabled' });
    const res = await addDomain(project.id, user.jwt, {
      domain: 'acme.com',
      apiToken: API_TOKEN_REPLACEMENT,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('token_revoked');
    expect(json.setup_state).toEqual({ failed_step: 'verify_credential' });

    // The early failure must not erase what the row already recorded.
    const after = (await rowFor(project.id, 'acme.com'))!;
    expect(after.status).toBe('token_revoked');
    expect(after.zone_id).toBe(before.zone_id);
    expect(after.account_id).toBe(before.account_id);
    expect(after.mode).toBe(before.mode);
    expect(after.relay_worker_name).toBe(before.relay_worker_name);
    expect((await mirrorFor('acme.com'))!.status).toBe('token_revoked');
  });

  it('refuses to overwrite an enabled catch-all that names another worker', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const stub = stubCustomerCf({
      zones: { 'acme.com': ZONE },
      catchAllRule: { enabled: true, workerName: 'someone-elses-worker' },
    });

    const res = await addDomain(project.id, user.jwt, { domain: 'acme.com', apiToken: API_TOKEN });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('failed');
    expect(json.setup_state).toEqual({ failed_step: 'catch_all' });
    expect(String(json.error)).toContain('someone-elses-worker');
    // The relay deployed (the row keeps its name for repair), but the
    // foreign rule was never overwritten.
    expect(json.relay_worker_name).toBe(RELAY_WORKER_BASE_NAME);
    expect(callsByTag(stub.calls, 'catchAllGet')).toHaveLength(1);
    expect(callsByTag(stub.calls, 'catchAll')).toEqual([]);
  });

  it('re-adds a catch_all-failed row — the full setup re-runs and writes the rule', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    stubCustomerCf({
      zones: { 'acme.com': ZONE },
      failOn: { catchAll: { message: 'rules quota', status: 400 } },
    });
    await addDomain(project.id, user.jwt, { domain: 'acme.com', apiToken: API_TOKEN });
    const failedRow = (await rowFor(project.id, 'acme.com'))!;
    expect(failedRow.status).toBe('failed');
    expect(failedRow.relay_worker_name).toBe(RELAY_WORKER_BASE_NAME);

    // Re-add: the engine re-runs against the row's recorded progress — no
    // MX check (the first attempt's MX is ours), the already-done steps'
    // 4xx are believed only on their read-backs, the relay redeploys in
    // place, and the step the first attempt missed finally runs.
    const stub = stubCustomerCf({
      zones: { 'acme.com': ZONE },
      failOn: {
        routingDns: { message: 'already enabled', status: 400 },
        onboardSending: { message: 'already exists', status: 409 },
      },
      routingSettings: { enabled: true, status: 'ready' },
      sendingSubdomains: [{ name: 'acme.com', enabled: true }],
    });
    const res = await addDomain(project.id, user.jwt, {
      domain: 'acme.com',
      apiToken: API_TOKEN_REPLACEMENT,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('active');

    const tagList = tags(stub.calls);
    expect(tagList).not.toContain('mxLookup');
    // In-place redeploy: no name-walk, the recorded name is reused.
    expect(tagList).not.toContain('scriptGet');
    expect(tagList).toContain('routingSettingsGet');
    expect(tagList).toContain('sendingSubdomainsGet');
    expect(callsByTag(stub.calls, 'catchAll')[0]!.body).toEqual({
      matchers: [{ type: 'all' }],
      actions: [{ type: 'worker', value: [RELAY_WORKER_BASE_NAME] }],
      enabled: true,
    });
    const row = (await rowFor(project.id, 'acme.com'))!;
    expect(row.status).toBe('active');
    expect(row.relay_worker_name).toBe(RELAY_WORKER_BASE_NAME);
    expect((await mirrorFor('acme.com'))!.status).toBe('active');
  });

  it('revokes the old grant once the replaced credential is safely stored', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    stubCustomerCf({ zones: { 'acme.com': ZONE } });
    await addDomain(project.id, user.jwt, { domain: 'acme.com', refreshToken: REFRESH_TOKEN });
    // The first add rotated the chain: the row now holds
    // cf-rotated-refresh-dummy-1 — that is the grant the replace revokes.

    const stub = stubCustomerCf({ zones: { 'acme.com': ZONE } });
    const res = await addDomain(project.id, user.jwt, {
      domain: 'acme.com',
      refreshToken: 'cf-refresh-token-dummy-2',
    });
    expect(res.status).toBe(200);
    // One revoke, of the OLD chain head, fired right after the credential
    // replace committed — before the new grant's first refresh.
    const revocations = callsByTag(stub.calls, 'oauthRevoke');
    expect(revocations).toHaveLength(1);
    expect(revocations[0]!.form!.token).toBe('cf-rotated-refresh-dummy-1');
    expect(tags(stub.calls).indexOf('oauthRevoke')).toBeLessThan(
      tags(stub.calls).indexOf('oauthToken'),
    );
  });

  it('skips the revoke when the identical grant is re-pasted', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    stubCustomerCf({ zones: { 'acme.com': ZONE } });
    await addDomain(project.id, user.jwt, { domain: 'acme.com', refreshToken: REFRESH_TOKEN });

    // The stored chain head is cf-rotated-refresh-dummy-1; re-pasting THAT
    // exact plaintext must not revoke it — the revoke would brick the
    // just-stored credential.
    const stub = stubCustomerCf({ zones: { 'acme.com': ZONE } });
    const res = await addDomain(project.id, user.jwt, {
      domain: 'acme.com',
      refreshToken: 'cf-rotated-refresh-dummy-1',
    });
    expect(res.status).toBe(200);
    expect(callsByTag(stub.calls, 'oauthRevoke')).toEqual([]);
    // …and the chain simply continued from the re-pasted head.
    expect(callsByTag(stub.calls, 'oauthToken')[0]!.form!.refresh_token).toBe(
      'cf-rotated-refresh-dummy-1',
    );
  });

  it('compensates and 500s a post-deploy non-unique apply failure', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const stub = stubCustomerCf({
      zones: { 'acme.com': ZONE },
      verifyExpiresOn: APPLY_SENTINEL_EXPIRY,
      on: {
        // Installed in the catch-all PUT — the engine's last CF call before
        // the apply, so the deploy checkpoint has already committed. The
        // apply's UPDATE then fails NON-unique. The reconciliation's
        // re-read finds the checkpoint-persisted relay NAME but not the
        // apply's relay_version (the checkpoint never writes it), so the
        // row is NOT taken as applied: the orphaned relay is compensated
        // and the original error rethrows.
        catchAll: installApplySentinelTrigger,
      },
    });
    try {
      const res = await addDomain(project.id, user.jwt, {
        domain: 'acme.com',
        apiToken: API_TOKEN,
      });
      expect(res.status).toBe(500);
      // Compensation ran with the loser's OWN account_id (not a name
      // race): catch-all ownership read → reset, then the relay DELETE.
      expect(callsByTag(stub.calls, 'catchAllGet')).toHaveLength(2);
      expect(callsByTag(stub.calls, 'catchAll')).toHaveLength(2);
      expect(callsByTag(stub.calls, 'scriptDelete')).toHaveLength(1);
      // The stub's catch-all ends reset (disabled drop) — the engine's
      // write was rolled back CF-side by the compensation.
      expect(stub.catchAllStates.get(ZONE.id)).toEqual({ enabled: false, workerName: null });
      // The row keeps the checkpoint state: progress stands, but status
      // and token fields stay pre-apply, and no mirror was written.
      const row = (await rowFor(project.id, 'acme.com'))!;
      expect(row).toMatchObject({
        status: 'pending',
        zone_id: ZONE.id,
        account_id: ZONE.accountId,
        relay_worker_name: RELAY_WORKER_BASE_NAME,
        relay_version: null,
        token_id: null,
        token_expires_on: null,
      });
      expect(await mirrorFor('acme.com')).toBeNull();
    } finally {
      await dropApplySentinelTrigger();
    }
  });

  it('500s a non-unique apply failure when setup failed before the deploy', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const stub = stubCustomerCf({
      zones: { 'acme.com': ZONE },
      mx: { 'acme.com': ['aspmx.l.google.com'] },
      verifyExpiresOn: APPLY_SENTINEL_EXPIRY,
      on: { mxLookup: installApplySentinelTrigger },
    });
    try {
      const res = await addDomain(project.id, user.jwt, {
        domain: 'acme.com',
        apiToken: API_TOKEN,
      });
      // Nothing deployed → nothing to compensate: the error rethrows.
      expect(res.status).toBe(500);
      expect(callsByTag(stub.calls, 'catchAllGet')).toEqual([]);
      expect(callsByTag(stub.calls, 'scriptDelete')).toEqual([]);
      // The row keeps its pre-apply state.
      expect((await rowFor(project.id, 'acme.com'))!).toMatchObject({
        status: 'pending',
        zone_id: null,
        relay_worker_name: null,
      });
      expect(await mirrorFor('acme.com')).toBeNull();
    } finally {
      await dropApplySentinelTrigger();
    }
  });
});

// ---------------------------------------------------------------------------
// GET list / status
// ---------------------------------------------------------------------------

describe('GET /projects/:id/email/domains', () => {
  it('lists rows without secret material', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await addActiveDomain(project.id, user.jwt);

    const res = await listDomains(project.id, user.jwt);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ domain: 'acme.com', status: 'active' });
    const raw = JSON.stringify(rows);
    for (const leaked of [API_TOKEN, 'ciphertext', '_iv', 'key_version']) {
      expect(raw).not.toContain(leaked);
    }
  });
});

describe('GET /projects/:id/email/domains/:domain', () => {
  it('re-probes the credential and reports no drift on a healthy row', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await addActiveDomain(project.id, user.jwt);
    const mirrorBefore = await env.ROUTING.get('email-domain:acme.com');

    const stub = stubCustomerCf({
      zones: { 'acme.com': ZONE },
      existingScripts: [RELAY_WORKER_BASE_NAME],
      catchAllRule: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
    });
    const res = await domainStatus(project.id, 'acme.com', user.jwt);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({
      status: 'active',
      credential_status: 'active',
      relay_version: RELAY_VERSION,
      current_relay_version: RELAY_VERSION,
      relay_drift: false,
      relay_missing: false,
      catch_all: 'points_here',
      catch_all_drift: false,
    });
    // The probe re-verified the token, checked the relay exists, and read
    // the zone catch-all.
    expect(tags(stub.calls)).toEqual(['verifyToken', 'scriptGet', 'catchAllGet']);
    // A healthy probe does not rewrite the mirror (read-compare repair).
    expect(await env.ROUTING.get('email-domain:acme.com')).toBe(mirrorBefore);
  });

  it('reports a catch-all pointing at another worker as drift', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await addActiveDomain(project.id, user.jwt);

    stubCustomerCf({
      zones: { 'acme.com': ZONE },
      existingScripts: [RELAY_WORKER_BASE_NAME],
      catchAllRule: { enabled: true, workerName: 'someone-elses-worker' },
    });
    const res = await domainStatus(project.id, 'acme.com', user.jwt);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ catch_all: 'points_elsewhere', catch_all_drift: true });
  });

  it('reports a missing or disabled catch-all as drift', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await addActiveDomain(project.id, user.jwt);

    // No rule at all (CF 404).
    stubCustomerCf({
      zones: { 'acme.com': ZONE },
      existingScripts: [RELAY_WORKER_BASE_NAME],
      catchAllRule: null,
    });
    let res = await domainStatus(project.id, 'acme.com', user.jwt);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      catch_all: 'missing',
      catch_all_drift: true,
    });

    // CF's real default for a zone that never had a rule: a disabled drop.
    stubCustomerCf({
      zones: { 'acme.com': ZONE },
      existingScripts: [RELAY_WORKER_BASE_NAME],
    });
    res = await domainStatus(project.id, 'acme.com', user.jwt);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      catch_all: 'disabled',
      catch_all_drift: true,
    });
  });

  it('reports an unreachable catch-all probe as unknown, not drift', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await addActiveDomain(project.id, user.jwt);

    stubCustomerCf({
      zones: { 'acme.com': ZONE },
      existingScripts: [RELAY_WORKER_BASE_NAME],
      failOn: { catchAllGet: { message: 'boom', status: 500 } },
    });
    const res = await domainStatus(project.id, 'acme.com', user.jwt);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ catch_all: 'unknown', catch_all_drift: false });
  });

  it('skips mirror repair while a removal failure is pending', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const row = await seedEmailDomain(project.id, 'acme.com', { status: 'active' });
    // A keep-row DELETE left its mark: the row is mid-removal…
    await env.db
      .update(emailDomains)
      .set({
        setup_state: {
          failed_step: 'remove',
          removal_failed_steps: ['catch_all', 'delete_relay'],
        },
      })
      .where(eq(emailDomains.id, row.id));
    // …and the mirror drifted — a healthy row WOULD repair this back.
    await writeEmailDomainMirror(
      env.ROUTING,
      { ...row, status: 'failed' },
      await hashEmailRelaySecret(RELAY_SECRET),
    );
    const drifted = await env.ROUTING.get('email-domain:acme.com');

    stubCustomerCf({
      zones: { 'acme.com': ZONE },
      existingScripts: [RELAY_WORKER_BASE_NAME],
      catchAllRule: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
    });
    const res = await domainStatus(project.id, 'acme.com', user.jwt);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ status: 'active', catch_all: 'points_here' });
    // The proxy mirror must not be "repaired" against a state the operator
    // is about to finish removing.
    expect(await env.ROUTING.get('email-domain:acme.com')).toBe(drifted);
  });

  it('self-clears the sending-onboarding step once the read-back confirms it', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const row = await seedEmailDomain(project.id, 'acme.com', { status: 'active' });
    await env.db
      .update(emailDomains)
      .set({ setup_state: { remaining_steps: ['sending_onboarding'] } })
      .where(eq(emailDomains.id, row.id));

    // Not onboarded yet — the step survives the poll.
    stubCustomerCf({
      zones: { 'acme.com': ZONE },
      existingScripts: [RELAY_WORKER_BASE_NAME],
      catchAllRule: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
    });
    let res = await domainStatus(project.id, 'acme.com', user.jwt);
    expect(res.status).toBe(200);
    expect((await rowFor(project.id, 'acme.com'))!.setup_state).toEqual({
      remaining_steps: ['sending_onboarding'],
    });

    // Onboarded (a post-upgrade sync landed it) — the poll clears the
    // step; the row was already active, so only setup_state moves.
    const stub2 = stubCustomerCf({
      zones: { 'acme.com': ZONE },
      existingScripts: [RELAY_WORKER_BASE_NAME],
      catchAllRule: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
      sendingSubdomains: [{ name: 'acme.com', enabled: true }],
    });
    res = await domainStatus(project.id, 'acme.com', user.jwt);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('active');
    expect(json.setup_state).toBeNull();
    expect(callsByTag(stub2.calls, 'sendingSubdomainsGet')).toHaveLength(1);
  });

  it('does not apply a stale probe verdict when the credential was replaced mid-poll', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const row = await seedEmailDomain(project.id, 'acme.com', { status: 'active' });
    stubCustomerCf({
      zones: { 'acme.com': ZONE },
      verifyStatus: 'expired',
      existingScripts: [RELAY_WORKER_BASE_NAME],
      catchAllRule: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
      on: {
        // A renewal replace commits while the expired-verdict probe is in
        // flight: the OLD token's verdict must not land on the NEW
        // credential.
        verifyToken: async () => {
          const enc = await encryptEmailDomainToken(
            env,
            project.id,
            'acme.com',
            API_TOKEN_REPLACEMENT,
          );
          await env.db
            .update(emailDomains)
            .set({
              credential_kind: 'api_token',
              token_ciphertext: enc.ciphertext,
              token_iv: enc.iv,
              token_key_version: enc.keyVersion,
              token_id: null,
              token_expires_on: null,
            })
            .where(eq(emailDomains.id, row.id));
        },
      },
    });

    const res = await domainStatus(project.id, 'acme.com', user.jwt);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    // The fenced update refused the stale verdict; the probe is reported
    // void, and the row keeps the replacement's state and status.
    expect(json.credential_status).toBe('probe_failed');
    const fresh = (await rowFor(project.id, 'acme.com'))!;
    expect(fresh.status).toBe('active');
    expect(await decryptEmailDomainToken(env, project.id, 'acme.com', fresh)).toBe(
      API_TOKEN_REPLACEMENT,
    );
    expect((await mirrorFor('acme.com'))!.status).toBe('active');
  });

  it('does not recreate the mirror when the project is torn down mid-poll', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await addActiveDomain(project.id, user.jwt);

    stubCustomerCf({
      zones: { 'acme.com': ZONE },
      existingScripts: [RELAY_WORKER_BASE_NAME],
      catchAllRule: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
      on: {
        // Teardown lands between the last row re-read and the mirror
        // repair: its mirror clear ran, then the cascade took the rows.
        catchAllGet: async () => {
          await env.ROUTING.delete('email-domain:acme.com');
          await env.db.delete(projects).where(eq(projects.id, project.id));
        },
      },
    });
    const res = await domainStatus(project.id, 'acme.com', user.jwt);
    expect(res.status).toBe(200);
    // The repair must not resurrect the key teardown cleared — nothing
    // else would ever sweep it.
    expect(await env.ROUTING.get('email-domain:acme.com')).toBeNull();
  });

  it('flips a revoked token to token_revoked and repairs the mirror', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await addActiveDomain(project.id, user.jwt);

    stubCustomerCf({ verifyStatus: 'disabled' });
    const res = await domainStatus(project.id, 'acme.com', user.jwt);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.credential_status).toBe('revoked');
    expect(json.status).toBe('token_revoked');
    expect((await rowFor(project.id, 'acme.com'))!.status).toBe('token_revoked');
    expect((await mirrorFor('acme.com'))!.status).toBe('token_revoked');
  });

  it('probes an oauth_grant with one serialized refresh and drops the access token', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    stubCustomerCf({ zones: { 'acme.com': ZONE } });
    await addDomain(project.id, user.jwt, { domain: 'acme.com', refreshToken: REFRESH_TOKEN });

    const stub = stubCustomerCf({ zones: { 'acme.com': ZONE } });
    const res = await domainStatus(project.id, 'acme.com', user.jwt);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ credential_status: 'active', status: 'active' });
    // The status probe refreshed with the ROTATED token (the chain moved).
    expect(callsByTag(stub.calls, 'oauthToken')[0]!.form!.refresh_token).toBe(
      'cf-rotated-refresh-dummy-1',
    );
    const row = (await rowFor(project.id, 'acme.com'))!;
    expect(await decryptEmailDomainToken(env, project.id, 'acme.com', row)).toBe(
      'cf-rotated-refresh-dummy-2',
    );
    expect(JSON.stringify(json)).not.toContain('cf-access-dummy');
  });

  it('reports relay drift when the deployed version predates RELAY_VERSION', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await addActiveDomain(project.id, user.jwt);
    await env.db
      .update(emailDomains)
      .set({ relay_version: RELAY_VERSION - 1 })
      .where(eq(emailDomains.project_id, project.id));

    stubCustomerCf({ zones: { 'acme.com': ZONE }, existingScripts: [RELAY_WORKER_BASE_NAME] });
    const res = await domainStatus(project.id, 'acme.com', user.jwt);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.relay_version).toBe(RELAY_VERSION - 1);
    expect(json.relay_drift).toBe(true);
    expect(json.relay_missing).toBe(false);
  });

  it('reports a missing relay as drift', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await addActiveDomain(project.id, user.jwt);

    // scriptGet 404s by default — the customer deleted the relay themselves.
    stubCustomerCf({ zones: { 'acme.com': ZONE } });
    const res = await domainStatus(project.id, 'acme.com', user.jwt);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.relay_missing).toBe(true);
    expect(json.relay_drift).toBe(true);
  });

  it('self-clears the routing-subdomain human step once public MX names Cloudflare', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    stubCustomerCf({
      zones: { 'acme.com': ZONE },
      failOn: { routingDns: { message: 'forbidden', status: 403 } },
    });
    await addDomain(project.id, user.jwt, { domain: 'mail.acme.com', apiToken: API_TOKEN });
    expect((await rowFor(project.id, 'mail.acme.com'))!.status).toBe('pending');

    // The human did the dashboard step: the subdomain's MX now points at
    // Cloudflare's inbound exchanges.
    stubCustomerCf({
      zones: { 'acme.com': ZONE },
      mx: { 'mail.acme.com': ['route1.mx.cloudflare.net', 'route2.mx.cloudflare.net'] },
      existingScripts: [RELAY_WORKER_BASE_NAME],
    });
    const res = await domainStatus(project.id, 'mail.acme.com', user.jwt);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('active');
    expect(json.setup_state).toBe(null);
    expect((await rowFor(project.id, 'mail.acme.com'))!.status).toBe('active');
    // The mirror repair carried the new status to the proxy.
    expect((await mirrorFor('mail.acme.com'))!.status).toBe('active');
  });

  it('does not self-clear steps or reactivate while a removal failure is pending', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    stubCustomerCf({
      zones: { 'acme.com': ZONE },
      failOn: { routingDns: { message: 'forbidden', status: 403 } },
    });
    await addDomain(project.id, user.jwt, { domain: 'mail.acme.com', apiToken: API_TOKEN });
    const pending = (await rowFor(project.id, 'mail.acme.com'))!;
    expect(pending.status).toBe('pending');

    // A DELETE then fails its CF cleanup: the row is kept for retry,
    // marked with failed_step 'remove' (the DELETE route's real writer).
    await markEmailDomainRemovalFailed(env.db, pending.id, ['relay_delete']);

    // The human did the dashboard step mid-removal: the subdomain's MX
    // now points at Cloudflare. The poll must neither clear the steps
    // nor flip active — the row is the operator's to finish removing,
    // and the mirror repair suppression (failed_step) must survive.
    stubCustomerCf({
      zones: { 'acme.com': ZONE },
      mx: { 'mail.acme.com': ['route1.mx.cloudflare.net', 'route2.mx.cloudflare.net'] },
      existingScripts: [RELAY_WORKER_BASE_NAME],
    });
    const res = await domainStatus(project.id, 'mail.acme.com', user.jwt);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('pending');
    const fresh = (await rowFor(project.id, 'mail.acme.com'))!;
    expect(fresh.status).toBe('pending');
    expect(fresh.setup_state).toEqual({
      remaining_steps: ['routing_subdomain'],
      failed_step: 'remove',
      removal_failed_steps: ['relay_delete'],
    });
    // The mirror keeps the pending status — not reactivated mid-removal.
    expect((await mirrorFor('mail.acme.com'))!.status).toBe('pending');
  });

  it('does not flip a revoked row back to active when the revocation lands mid-poll', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    stubCustomerCf({
      zones: { 'acme.com': ZONE },
      failOn: { routingDns: { message: 'forbidden', status: 403 } },
    });
    await addDomain(project.id, user.jwt, { domain: 'mail.acme.com', apiToken: API_TOKEN });
    const pending = (await rowFor(project.id, 'mail.acme.com'))!;

    stubCustomerCf({
      zones: { 'acme.com': ZONE },
      mx: { 'mail.acme.com': ['route1.mx.cloudflare.net', 'route2.mx.cloudflare.net'] },
      existingScripts: [RELAY_WORKER_BASE_NAME],
      on: {
        // A concurrent refresh consumes the dead grant (invalid_grant)
        // and persists token_revoked while the MX evidence check is in
        // flight — the self-clear must not overwrite it back to active.
        mxLookup: async () => {
          await env.db
            .update(emailDomains)
            .set({ status: 'token_revoked', updated_at: sql`now()` })
            .where(eq(emailDomains.id, pending.id));
        },
      },
    });
    const res = await domainStatus(project.id, 'mail.acme.com', user.jwt);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    // The fenced-out self-clear voided: the row keeps the revoked state
    // and its recorded steps...
    expect(json.status).toBe('token_revoked');
    const fresh = (await rowFor(project.id, 'mail.acme.com'))!;
    expect(fresh.status).toBe('token_revoked');
    expect(fresh.setup_state).toEqual({ remaining_steps: ['routing_subdomain'] });
    // ...and the mirror repair converges the mirror to the true row.
    expect((await mirrorFor('mail.acme.com'))!.status).toBe('token_revoked');
  });

  it('stays pending while the subdomain has no Cloudflare MX', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    stubCustomerCf({
      zones: { 'acme.com': ZONE },
      failOn: { routingDns: { message: 'forbidden', status: 403 } },
    });
    await addDomain(project.id, user.jwt, { domain: 'mail.acme.com', apiToken: API_TOKEN });

    stubCustomerCf({ zones: { 'acme.com': ZONE }, existingScripts: [RELAY_WORKER_BASE_NAME] });
    const res = await domainStatus(project.id, 'mail.acme.com', user.jwt);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('pending');
    expect(json.setup_state).toEqual({ remaining_steps: ['routing_subdomain'] });
  });

  it('404s for an unknown domain', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const res = await domainStatus(project.id, 'acme.com', user.jwt);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// sync / remove
// ---------------------------------------------------------------------------

describe('POST /projects/:id/email/domains/:domain/sync', () => {
  it('redeploys the relay and rotates the secret, mirroring the new sha256', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await addActiveDomain(project.id, user.jwt);
    const before = await mirrorFor('acme.com');

    // The stub's zone starts at CF's disabled-drop default, so the sync's
    // catch-all ensure repoints it at the row's relay.
    const stub = stubCustomerCf({ zones: { 'acme.com': ZONE } });
    const res = await syncDomain(project.id, 'acme.com', user.jwt);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({
      status: 'active',
      relay_version: RELAY_VERSION,
      catch_all: 'ensured',
    });
    expect(tags(stub.calls)).toEqual([
      'verifyToken',
      'scriptPut',
      'secretPut',
      'catchAllGet',
      'catchAll',
    ]);
    expect(stub.catchAllStates.get(ZONE.id)).toEqual({
      enabled: true,
      workerName: RELAY_WORKER_BASE_NAME,
    });
    const after = await mirrorFor('acme.com');
    expect(after!.relaySecretSha256).not.toBe(before!.relaySecretSha256);
  });

  it('rolls the row back when the mirror write fails mid-sync', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await addActiveDomain(project.id, user.jwt);
    const before = (await rowFor(project.id, 'acme.com'))!;
    const beforeMirror = (await mirrorFor('acme.com'))!;

    stubCustomerCf({ zones: { 'acme.com': ZONE } });
    // The mirror PUT is part of the serialized sync: its failure must
    // roll the row apply back with it — never leave the row rotated to a
    // secret the mirror does not name. (The reverse ordering is what the
    // lock is for: two overlapping syncs publishing hashes out of order
    // would break inbound auth the same way.)
    const put = vi.spyOn(env.ROUTING, 'put').mockRejectedValueOnce(new Error('kv down'));
    const res = await syncDomain(project.id, 'acme.com', user.jwt);
    expect(res.status).toBe(500);
    put.mockRestore();

    const after = (await rowFor(project.id, 'acme.com'))!;
    expect(after.relay_ciphertext).toBe(before.relay_ciphertext);
    expect(after.relay_version).toBe(before.relay_version);
    expect(after.status).toBe(before.status);
    expect((await mirrorFor('acme.com'))!.relaySecretSha256).toBe(beforeMirror.relaySecretSha256);
  });

  it('reports a foreign catch-all without overwriting it', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await addActiveDomain(project.id, user.jwt);

    const stub = stubCustomerCf({
      zones: { 'acme.com': ZONE },
      catchAllRule: { enabled: true, workerName: 'someone-elses-worker' },
    });
    const res = await syncDomain(project.id, 'acme.com', user.jwt);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    // Report, don't fight: the conflict surfaces in the response, the
    // redeploy/rotation still succeed, and the foreign rule is never
    // written.
    expect(json).toMatchObject({ status: 'active', catch_all: 'foreign_conflict' });
    expect(tags(stub.calls)).toEqual(['verifyToken', 'scriptPut', 'secretPut', 'catchAllGet']);
    expect(stub.catchAllStates.get(ZONE.id)).toEqual({
      enabled: true,
      workerName: 'someone-elses-worker',
    });
  });

  it('409s when the live-status flip collides with the zone winner', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    // A 'failed' row still RECORDS its zone (the partial zone index ignores
    // 'failed'), so sync's flip back to a live status is where the race
    // surfaces. No compensation runs on the sync path: the deploy was in
    // place on the row's OWN relay, so only the flip is refused.
    await seedEmailDomain(project.id, 'acme.com', {
      status: 'failed',
      relayWorkerName: `${RELAY_WORKER_BASE_NAME}-a`,
    });
    await seedEmailDomain(project.id, 'other.com', {
      status: 'active',
      relayWorkerName: `${RELAY_WORKER_BASE_NAME}-b`,
    });

    const stub = stubCustomerCf({ zones: { 'acme.com': ZONE } });
    const res = await syncDomain(project.id, 'acme.com', user.jwt);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      'another active email domain already uses this zone — remove it first',
    );

    // The redeploy + catch-all ensure ran; the refused flip changed nothing
    // else — no compensation delete, and the row and mirror keep 'failed'.
    expect(tags(stub.calls)).toEqual([
      'verifyToken',
      'scriptPut',
      'secretPut',
      'catchAllGet',
      'catchAll',
    ]);
    expect(callsByTag(stub.calls, 'scriptDelete')).toEqual([]);
    expect((await rowFor(project.id, 'acme.com'))!.status).toBe('failed');
    expect((await mirrorFor('acme.com'))!.status).toBe('failed');
  });

  it('keeps a pending human step on the row', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    stubCustomerCf({
      zones: { 'acme.com': ZONE },
      failOn: { routingDns: { message: 'forbidden', status: 403 } },
    });
    await addDomain(project.id, user.jwt, { domain: 'mail.acme.com', apiToken: API_TOKEN });

    stubCustomerCf({ zones: { 'acme.com': ZONE } });
    const res = await syncDomain(project.id, 'mail.acme.com', user.jwt);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('pending');
    expect(json.setup_state).toEqual({ remaining_steps: ['routing_subdomain'] });
  });

  it('re-attempts a pending sending onboarding and clears the step', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const row = await seedEmailDomain(project.id, 'acme.com', { status: 'active' });
    await env.db
      .update(emailDomains)
      .set({ setup_state: { remaining_steps: ['sending_onboarding'] } })
      .where(eq(emailDomains.id, row.id));

    // The upgrade landed; the sync's retry onboards and the step clears.
    const stub = stubCustomerCf({
      zones: { 'acme.com': ZONE },
      catchAllRule: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
    });
    const res = await syncDomain(project.id, 'acme.com', user.jwt);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('active');
    expect(json.setup_state).toBeNull();
    expect(callsByTag(stub.calls, 'onboardSending')).toHaveLength(1);
  });

  it('keeps the sending step when the sync retry is refused again', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const row = await seedEmailDomain(project.id, 'acme.com', { status: 'active' });
    await env.db
      .update(emailDomains)
      .set({ setup_state: { remaining_steps: ['sending_onboarding'] } })
      .where(eq(emailDomains.id, row.id));

    const stub = stubCustomerCf({
      zones: { 'acme.com': ZONE },
      catchAllRule: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
      failOn: {
        onboardSending: {
          message: 'account is not entitled to Email Sending',
          status: 403,
          code: 10105,
        },
      },
    });
    const res = await syncDomain(project.id, 'acme.com', user.jwt);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    // The sync itself succeeded; only the step rides along.
    expect(json.status).toBe('active');
    expect(json.setup_state).toEqual({ remaining_steps: ['sending_onboarding'] });
    expect(callsByTag(stub.calls, 'onboardSending')).toHaveLength(1);
  });

  it('marks the row failed when the redeploy fails', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await addActiveDomain(project.id, user.jwt);

    stubCustomerCf({ failOn: { scriptPut: { message: 'quota', status: 400 } } });
    const res = await syncDomain(project.id, 'acme.com', user.jwt);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('failed');
    expect(json.setup_state).toEqual({ failed_step: 'deploy_relay' });
    expect((await mirrorFor('acme.com'))!.status).toBe('failed');
  });
});

describe('DELETE /projects/:id/email/domains/:domain', () => {
  it('removes CF state best-effort, then the mirror key and the row', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await addActiveDomain(project.id, user.jwt);

    const stub = stubCustomerCf({
      catchAllRule: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
    });
    const res = await removeDomain(project.id, 'acme.com', user.jwt);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: true });
    // Contract 7 remove shape: catch-all ownership read, the conditional
    // reset (drop, disabled) since the read names our relay, then the
    // relay DELETE — the enabled rule never outlives its worker.
    expect(tags(stub.calls)).toEqual(['catchAllGet', 'catchAll', 'scriptDelete']);
    expect(callsByTag(stub.calls, 'catchAll')[0]!.body).toEqual({
      matchers: [{ type: 'all' }],
      actions: [{ type: 'drop' }],
      enabled: false,
    });
    expect(stub.catchAllStates.get(ZONE.id)).toEqual({ enabled: false, workerName: null });
    expect(await rowFor(project.id, 'acme.com')).toBeUndefined();
    expect(await mirrorFor('acme.com')).toBeNull();
  });

  it('keeps the row and mirror when destructive CF cleanup fails, marked for retry', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await addActiveDomain(project.id, user.jwt);

    const stub = stubCustomerCf({
      catchAllRule: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
      failOn: {
        catchAll: { message: 'boom', status: 500 },
      },
    });
    const res = await removeDomain(project.id, 'acme.com', user.jwt);
    expect(res.status).toBe(200);
    // The reset failed, so the relay DELETE is skipped deliberately — an
    // enabled catch-all must never point at a deleted worker, so the rule
    // and its relay stay a consistent pair and both steps report failed.
    // A failed DESTRUCTIVE step KEEPS the row so the operator can retry.
    expect(await res.json()).toEqual({
      ok: false,
      removed: false,
      failed_steps: ['catch_all', 'delete_relay'],
    });
    expect(tags(stub.calls)).toEqual(['catchAllGet', 'catchAll']);
    // The row is marked mid-removal; the mirror stays for the proxy.
    const row = (await rowFor(project.id, 'acme.com'))!;
    expect(row.status).toBe('active');
    expect(row.setup_state).toEqual({
      failed_step: 'remove',
      removal_failed_steps: ['catch_all', 'delete_relay'],
    });
    expect((await mirrorFor('acme.com'))!.status).toBe('active');
  });

  it('force-removes the row and mirror despite failed destructive cleanup', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await addActiveDomain(project.id, user.jwt);

    const stub = stubCustomerCf({
      catchAllRule: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
      failOn: {
        catchAll: { message: 'boom', status: 500 },
      },
    });
    const res = await removeDomain(project.id, 'acme.com', user.jwt, { force: true });
    expect(res.status).toBe(200);
    // The same destructive failure that KEEPS the row without force is
    // overridden — and the response says so.
    expect(await res.json()).toEqual({
      ok: true,
      removed: true,
      forced: true,
      failed_steps: ['catch_all', 'delete_relay'],
    });
    expect(tags(stub.calls)).toEqual(['catchAllGet', 'catchAll']);
    expect(await rowFor(project.id, 'acme.com')).toBeUndefined();
    expect(await mirrorFor('acme.com')).toBeNull();
  });

  it('removes a token_revoked row even when destructive CF cleanup fails', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await seedEmailDomain(project.id, 'acme.com', { status: 'token_revoked' });

    const stub = stubCustomerCf({
      catchAllRule: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
      failOn: {
        catchAll: { message: 'boom', status: 500 },
      },
    });
    const res = await removeDomain(project.id, 'acme.com', user.jwt);
    expect(res.status).toBe(200);
    // token_revoked rows always delete — keeping buys no retry leverage
    // (re-add is the renewal path). `forced` stays absent without ?force=1.
    expect(await res.json()).toEqual({
      ok: true,
      removed: true,
      failed_steps: ['catch_all', 'delete_relay'],
    });
    expect(await rowFor(project.id, 'acme.com')).toBeUndefined();
    expect(await mirrorFor('acme.com')).toBeNull();
  });

  it('revokes the grant LAST, with the rotated refresh token, on an oauth_grant remove', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await seedEmailDomain(project.id, 'acme.com', {
      status: 'active',
      credentialKind: 'oauth_grant',
      credential: REFRESH_TOKEN,
    });

    const stub = stubCustomerCf({
      catchAllRule: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
    });
    const res = await removeDomain(project.id, 'acme.com', user.jwt);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: true });
    // Refresh first (the CF calls ride the fresh access token), revoke LAST
    // — and the revoked token is the ROTATED chain head, since the refresh
    // consumed the stored original.
    expect(tags(stub.calls)).toEqual([
      'oauthToken',
      'catchAllGet',
      'catchAll',
      'scriptDelete',
      'oauthRevoke',
    ]);
    const revocations = callsByTag(stub.calls, 'oauthRevoke');
    expect(revocations).toHaveLength(1);
    expect(revocations[0]!.form!.token).toBe('cf-rotated-refresh-dummy-1');
    expect(await rowFor(project.id, 'acme.com')).toBeUndefined();
    expect(await mirrorFor('acme.com')).toBeNull();
  });

  it('revokes the chain head live at revoke time when a lease refresh interleaves the cleanup', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const row = await seedEmailDomain(project.id, 'acme.com', {
      status: 'active',
      credentialKind: 'oauth_grant',
      credential: REFRESH_TOKEN,
    });

    const stub = stubCustomerCf({
      catchAllRule: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
      on: {
        // A lease rotation landing mid-cleanup: the removal's own rotation
        // (round 1) is already consumed by the time the revoke runs.
        catchAllGet: async () => {
          await refreshOauthGrantSerialized(env.db, env, row.id);
        },
      },
    });
    const res = await removeDomain(project.id, 'acme.com', user.jwt);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: true });
    // The interleaved lease's token call records between the ownership
    // read and the reset.
    expect(tags(stub.calls)).toEqual([
      'oauthToken',
      'catchAllGet',
      'oauthToken',
      'catchAll',
      'scriptDelete',
      'oauthRevoke',
    ]);
    const revocations = callsByTag(stub.calls, 'oauthRevoke');
    expect(revocations).toHaveLength(1);
    // The revoke submits the LIVE head (round 2), not the removal's own
    // rotation — CF answers 200 for a consumed token whether or not the
    // grant survived, so only the live head makes the 200 mean the chain
    // is dead.
    expect(revocations[0]!.form!.token).toBe('cf-rotated-refresh-dummy-2');
    expect(await rowFor(project.id, 'acme.com')).toBeUndefined();
    expect(await mirrorFor('acme.com')).toBeNull();
  });

  it('removes an active oauth row whose removal refresh hits invalid_grant — token_revoked lands mid-removal', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await seedEmailDomain(project.id, 'acme.com', {
      status: 'active',
      credentialKind: 'oauth_grant',
      credential: REFRESH_TOKEN,
    });

    const stub = stubCustomerCf({
      catchAllRule: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
      oauth: 'invalid_grant',
    });
    const res = await removeDomain(project.id, 'acme.com', user.jwt);
    expect(res.status).toBe(200);
    // invalid_grant persisted token_revoked inside the removal, so the
    // destructive failure takes the SAME unconditional-delete path as a
    // row revoked before the request — keeping it would strand a stale
    // active mirror with status-GET repair suppressed (failed_step
    // 'remove').
    expect(await res.json()).toEqual({
      ok: true,
      removed: true,
      failed_steps: ['delete_relay', 'catch_all'],
    });
    // The refresh failed before any customer-zone call, and invalid_grant
    // skips the revoke — CF already killed the grant.
    expect(tags(stub.calls)).toEqual(['oauthToken']);
    expect(await rowFor(project.id, 'acme.com')).toBeUndefined();
    expect(await mirrorFor('acme.com')).toBeNull();
  });

  it('still removes the row when the grant revocation itself fails', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await seedEmailDomain(project.id, 'acme.com', {
      status: 'active',
      credentialKind: 'oauth_grant',
      credential: REFRESH_TOKEN,
    });

    const stub = stubCustomerCf({
      catchAllRule: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
      failOn: { oauthRevoke: { message: 'boom', status: 500 } },
    });
    const res = await removeDomain(project.id, 'acme.com', user.jwt);
    expect(res.status).toBe(200);
    // A stranded grant breaks no mail, but it is no longer SILENT:
    // revokeOauthGrant throws on the 500, the engine records revoke_grant,
    // and the route surfaces it — non-destructive, so removal proceeds.
    expect(await res.json()).toEqual({ ok: true, removed: true, failed_steps: ['revoke_grant'] });
    expect(callsByTag(stub.calls, 'oauthRevoke')).toHaveLength(1);
    expect(await rowFor(project.id, 'acme.com')).toBeUndefined();
    expect(await mirrorFor('acme.com')).toBeNull();
  });

  it('leaves a catch-all pointing at another worker untouched', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await addActiveDomain(project.id, user.jwt);

    const stub = stubCustomerCf({
      catchAllRule: { enabled: true, workerName: 'someone-elses-worker' },
    });
    const res = await removeDomain(project.id, 'acme.com', user.jwt);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: true });
    // The relay is ours to delete; the foreign catch-all is not ours to reset.
    expect(tags(stub.calls)).toEqual(['catchAllGet', 'scriptDelete']);
    expect(await rowFor(project.id, 'acme.com')).toBeUndefined();
    expect(await mirrorFor('acme.com')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /internal/email/domain-credential — the proxy's lease
// ---------------------------------------------------------------------------

describe('POST /internal/email/domain-credential', () => {
  it('401s without the internal header and 403s on a bad signature', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await seedEmailDomain(project.id, 'acme.com', { status: 'active' });

    expect((await leaseCredentialUnsigned('acme.com')).status).toBe(401);
    // Signed over a different value than the body carries.
    expect((await leaseCredential('acme.com', 'other.com')).status).toBe(403);
  });

  it('404s a domain with no mirror', async () => {
    const res = await leaseCredential('unknown.com');
    expect(res.status).toBe(404);
  });

  it('409s a non-active row', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await seedEmailDomain(project.id, 'acme.com', { status: 'pending' });

    const res = await leaseCredential('acme.com');
    expect(res.status).toBe(409);
  });

  it('leases an api_token verbatim', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await seedEmailDomain(project.id, 'acme.com', { status: 'active' });
    const stub = stubCustomerCf();

    const res = await leaseCredential('acme.com');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: 'api_token', token: API_TOKEN });
    // No refresh, no CF calls — the stored token IS the lease.
    expect(stub.calls).toEqual([]);
  });

  it('leases an oauth_grant access token and persists the rotation, serialized per row', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await seedEmailDomain(project.id, 'acme.com', {
      status: 'active',
      credentialKind: 'oauth_grant',
      credential: REFRESH_TOKEN,
    });
    const stub = stubCustomerCf();

    const first = await leaseCredential('acme.com');
    expect(await first.json()).toEqual({ kind: 'oauth_grant', accessToken: 'cf-access-dummy-1' });
    // The rotated refresh token was persisted atomically with the lease.
    let row = (await rowFor(project.id, 'acme.com'))!;
    expect(await decryptEmailDomainToken(env, project.id, 'acme.com', row)).toBe(
      'cf-rotated-refresh-dummy-1',
    );

    // The next lease continues the chain from the row, not from memory.
    const second = await leaseCredential('acme.com');
    expect(await second.json()).toEqual({ kind: 'oauth_grant', accessToken: 'cf-access-dummy-2' });
    row = (await rowFor(project.id, 'acme.com'))!;
    expect(await decryptEmailDomainToken(env, project.id, 'acme.com', row)).toBe(
      'cf-rotated-refresh-dummy-2',
    );
    expect(callsByTag(stub.calls, 'oauthToken').map((call) => call.form!.refresh_token)).toEqual([
      REFRESH_TOKEN,
      'cf-rotated-refresh-dummy-1',
    ]);
  });

  it('leases the replacement credential when a replace commits before the refresh lock', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const row = await seedEmailDomain(project.id, 'acme.com', {
      status: 'active',
      credentialKind: 'oauth_grant',
      credential: REFRESH_TOKEN,
    });
    const stub = stubCustomerCf();
    // The replace commits between the caller's unlocked row read and the
    // refresh's lock: the row now holds an API token.
    const replacement = await encryptEmailDomainToken(env, project.id, 'acme.com', API_TOKEN);
    await env.db
      .update(emailDomains)
      .set({
        credential_kind: 'api_token',
        token_ciphertext: replacement.ciphertext,
        token_iv: replacement.iv,
        token_key_version: replacement.keyVersion,
      })
      .where(eq(emailDomains.id, row.id));

    // The stale oauth snapshot re-reads and leases what the row NOW
    // holds. The grant endpoint never sees the API token — a real one
    // would answer invalid_grant and the flip would mark the FRESH
    // credential revoked.
    const outcome = await leaseEmailDomainCredential(env.db, env, row);
    expect(outcome).toEqual({ ok: true, lease: { kind: 'api_token', token: API_TOKEN } });
    expect(callsByTag(stub.calls, 'oauthToken')).toEqual([]);
    expect((await rowFor(project.id, 'acme.com'))!.status).toBe('active');
  });

  it('maps invalid_grant at lease time to token_revoked, persisted and mirrored', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await seedEmailDomain(project.id, 'acme.com', {
      status: 'active',
      credentialKind: 'oauth_grant',
      credential: REFRESH_TOKEN,
    });
    stubCustomerCf({ oauth: 'invalid_grant' });

    const res = await leaseCredential('acme.com');
    expect(res.status).toBe(403);
    expect((await rowFor(project.id, 'acme.com'))!.status).toBe('token_revoked');
    expect((await mirrorFor('acme.com'))!.status).toBe('token_revoked');
    // The lease failure never carries credential material.
    const body = await res.text();
    expect(body).not.toContain(REFRESH_TOKEN);
  });

  it('502s a transient OAuth failure without touching the row status', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await seedEmailDomain(project.id, 'acme.com', {
      status: 'active',
      credentialKind: 'oauth_grant',
      credential: REFRESH_TOKEN,
    });
    stubCustomerCf({ oauth: 'server_error' });

    const res = await leaseCredential('acme.com');
    expect(res.status).toBe(502);
    expect((await rowFor(project.id, 'acme.com'))!.status).toBe('active');
  });
});
