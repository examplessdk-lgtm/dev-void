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
import type { Db } from '../../src/db.ts';
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
import { setTestDb } from './setup.ts';

let env: TestEnv;

// Dummy stand-ins — never real token/secret material.
const API_TOKEN = 'cf-api-token-dummy';
const API_TOKEN_REPLACEMENT = 'cf-api-token-replacement-dummy';
const REFRESH_TOKEN = 'cf-refresh-token-dummy';
const RELAY_SECRET = 'relay-secret-dummy';
const ZONE = { id: 'zone_1', name: 'acme.com', accountId: 'acct_1' };

/**
 * Pause the app's Nth `db.transaction` until released — the seam for
 * landing a committed write (a replace, a teardown status flip) between a
 * route's unlocked entry checks and its serialized section. PGlite's
 * single connection forbids touching the db from inside an open
 * transaction, so the write must happen BEFORE the tx starts: the proxy
 * pauses prior to delegating, the test writes through the unwrapped
 * `realDb` (or a concurrent request's pass-through transactions), then
 * releases. Same pattern as cli-version-gate.test.ts.
 */
function pauseNthTransaction(
  realDb: Db,
  n: number,
): {
  wrappedDb: Db;
  reached: Promise<void>;
  release: () => void;
} {
  const realTransaction = realDb.transaction.bind(realDb);
  let releaseFn: (() => void) | undefined;
  let reachedFn: (() => void) | undefined;
  const reached = new Promise<void>((r) => {
    reachedFn = r;
  });
  let seen = 0;
  const wrappedDb = new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return (async (fn: never) => {
          seen += 1;
          if (seen === n) {
            reachedFn?.();
            await new Promise<void>((r) => {
              releaseFn = r;
            });
          }
          return realTransaction(fn);
        }) as unknown as typeof realDb.transaction;
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Db;
  return { wrappedDb, reached, release: () => releaseFn?.() };
}

function pauseFirstTransaction(realDb: Db) {
  return pauseNthTransaction(realDb, 1);
}

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
  // Per-script sha256 of the last secret PUT text (never the text).
  const secretHashes = new Map<string, string>();
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

    const secretsMatch = /\/workers\/scripts\/([^/]+)\/secrets$/.exec(path);
    if (secretsMatch && method === 'PUT') {
      const parsed = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      const text = typeof parsed.text === 'string' ? parsed.text : '';
      // The worker's CURRENT secret, tracked by sha256 only — the same
      // form the ROUTING mirror stores — so a test can prove worker, row
      // and mirror carry ONE secret without the value ever being recorded.
      secretHashes.set(secretsMatch[1]!, await hashEmailRelaySecret(text));
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
  return { calls, fn, catchAllStates, secretHashes };
}

function callsByTag(calls: Array<RecordedCall>, tag: StubFailTag): Array<RecordedCall> {
  return calls.filter((call) => call.tag === tag);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      // Idempotent: tests pre-install before the request and the sentinel
      // must survive any number of non-apply UPDATEs until the apply fires.
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
// CHECKPOINT write instead. The engine's pre-upload claim writes
// relay_worker_name first, so the checkpoint's distinguishing transition
// is zone_id null→non-null (the claim never touches zone_id; the final
// apply writes it already-set) — a NON-unique error here fails exactly
// the checkpoint.
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
       FOR EACH ROW WHEN (OLD.zone_id IS NULL AND NEW.zone_id IS NOT NULL)
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
    // Nothing was stored. The only CF call is the revoke of the 'both
    // credentials' case's posted grant — a rejected minted grant whose only
    // copy the CLI drops must not be stranded live in the customer's
    // account. api_token bodies carry no revoke primitive.
    expect(tags(stub.calls)).toEqual(['oauthRevoke']);
    expect(stub.calls[0]!.form!.token).toBe(REFRESH_TOKEN);
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

  it('409s a conflicting oauth add and revokes the rejected grant — unless it is the winner’s own', async () => {
    const user = await createTestUser(env.db);
    const first = await createTestProject(env.db, user.id);
    const second = await createTestProject(env.db, user.id);
    // The winner holds an oauth grant.
    await seedEmailDomain(first.id, 'acme.com', {
      status: 'active',
      credentialKind: 'oauth_grant',
      credential: REFRESH_TOKEN,
    });
    const stub = stubCustomerCf({});

    // A DIFFERENT freshly minted grant loses the claim: revoked. The CLI
    // drops its only copy of the grant on the 409, so without the revoke a
    // live broad grant strands in the customer's account per retry.
    const res = await addDomain(second.id, user.jwt, {
      domain: 'acme.com',
      refreshToken: 'cf-refresh-token-dummy-other',
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      'domain is registered to another project',
    );
    expect(tags(stub.calls)).toEqual(['oauthRevoke']);
    expect(stub.calls[0]!.form!.token).toBe('cf-refresh-token-dummy-other');

    // The SAME grant re-pasted must NOT be revoked — revoking the winner's
    // own stored credential would brick its live row (the decrypt-compare
    // guard fails safe toward keeping).
    const repasted = await addDomain(second.id, user.jwt, {
      domain: 'acme.com',
      refreshToken: REFRESH_TOKEN,
    });
    expect(repasted.status).toBe(409);
    expect(tags(stub.calls)).toEqual(['oauthRevoke']);
    expect((await rowFor(first.id, 'acme.com'))!.status).toBe('active');
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

  it('claims the relay name before the upload — a db-held name is skipped and never written', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    // Row one (seeded directly, same reason as the zone race above) already
    // holds 'void-email-relay-2' in the account — committed, so a
    // concurrent walk's claim of '-2' 23505s on the relay index.
    await seedEmailDomain(project.id, 'acme.com', {
      status: 'active',
      relayWorkerName: `${RELAY_WORKER_BASE_NAME}-2`,
    });

    // Domain two resolves to a DIFFERENT zone in the SAME account. CF shows
    // only the BASE name physically present, so the CF probe alone would
    // walk to '-2' — pre-fix the loser OVERWROTE row one's worker there
    // before its checkpoint 23505d. The pre-upload claim is what skips
    // '-2' now, and the walk lands on '-3'.
    const stub = stubCustomerCf({
      zones: { 'other.com': { id: 'zone_2', name: 'other.com', accountId: ZONE.accountId } },
      existingScripts: [RELAY_WORKER_BASE_NAME],
    });
    // The winner's deployed secret on '-2', through the stub's own sha256
    // tracking (the same RELAY_SECRET the seeded mirror carries).
    const contested = `${RELAY_WORKER_BASE_NAME}-2`;
    await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ZONE.accountId}/workers/scripts/${contested}/secrets`,
      {
        method: 'PUT',
        body: JSON.stringify({
          name: RELAY_SECRET_BINDING,
          type: 'secret_text',
          text: RELAY_SECRET,
        }),
      },
    );
    const winnerHashBefore = stub.secretHashes.get(contested);
    expect(winnerHashBefore).toBe(await hashEmailRelaySecret(RELAY_SECRET));
    const winnerMirrorBefore = await mirrorFor('acme.com');
    const callsBeforeAdd = stub.calls.length;

    const res = await addDomain(project.id, user.jwt, { domain: 'other.com', apiToken: API_TOKEN });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('active');
    expect(json.relay_worker_name).toBe(`${RELAY_WORKER_BASE_NAME}-3`);

    // The walk CF-probed base, '-2' and '-3' in order…
    const during = stub.calls.slice(callsBeforeAdd);
    expect(callsByTag(during, 'scriptGet').map((call) => call.url)).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/${ZONE.accountId}/workers/scripts/${RELAY_WORKER_BASE_NAME}`,
      `https://api.cloudflare.com/client/v4/accounts/${ZONE.accountId}/workers/scripts/${contested}`,
      `https://api.cloudflare.com/client/v4/accounts/${ZONE.accountId}/workers/scripts/${RELAY_WORKER_BASE_NAME}-3`,
    ]);
    // …but the contested name was NEVER written — no script PUT, no
    // secret PUT, no delete. Stronger than the old 'never deleted': the
    // claim skips the name before any upload.
    const writes = [...callsByTag(during, 'scriptPut'), ...callsByTag(during, 'secretPut')];
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.some((call) => call.url.includes(`/${contested}`))).toBe(false);
    expect(callsByTag(during, 'scriptDelete')).toEqual([]);

    // The winner's worker secret and mirror are byte-identical; its row
    // is untouched.
    expect(stub.secretHashes.get(contested)).toBe(winnerHashBefore);
    expect(await mirrorFor('acme.com')).toEqual(winnerMirrorBefore);
    expect((await rowFor(project.id, 'acme.com'))!).toMatchObject({
      status: 'active',
      zone_id: ZONE.id,
      account_id: ZONE.accountId,
      relay_worker_name: contested,
    });

    // The loser went active on '-3': its catch-all names its own relay,
    // and worker, row and mirror carry ONE secret.
    expect(stub.catchAllStates.get('zone_2')).toEqual({
      enabled: true,
      workerName: `${RELAY_WORKER_BASE_NAME}-3`,
    });
    const loserRow = (await rowFor(project.id, 'other.com'))!;
    expect(loserRow).toMatchObject({
      status: 'active',
      zone_id: 'zone_2',
      account_id: ZONE.accountId,
      relay_worker_name: `${RELAY_WORKER_BASE_NAME}-3`,
    });
    const loserHash = await hashEmailRelaySecret(
      await decryptEmailDomainRelaySecret(env, project.id, 'other.com', loserRow),
    );
    expect(stub.secretHashes.get(`${RELAY_WORKER_BASE_NAME}-3`)).toBe(loserHash);
    expect((await mirrorFor('other.com'))!.relaySecretSha256).toBe(loserHash);
  });

  it('claims distinct relay names for two concurrent setups in the same account', async () => {
    const user = await createTestUser(env.db);
    const projectA = await createTestProject(env.db, user.id);
    const projectB = await createTestProject(env.db, user.id);

    // Two zones in ONE customer account, nothing deployed yet: both
    // name-walks start at the base name. The hold gives the overlap
    // window — the FIRST setup to reach its secret PUT parks until the
    // other settles or the cap fires (the same synchronization as
    // 'serializes concurrent setup retries'). PGlite's single connection
    // serializes the second request's transaction behind the first's
    // commit, so the interleave this actually exercises is the
    // COMMITTED-winner one: the loser's claim of the base name 23505s
    // past the winner's commit and its walk advances to '-2'. Pre-fix
    // the loser picked the same name from the CF probe, overwrote the
    // winner's worker with its own binding + secret, and 409d at its
    // checkpoint.
    let holdFirstSecretPut = true;
    const stub = stubCustomerCf({
      zones: {
        'a.com': { id: 'zone_a', name: 'a.com', accountId: ZONE.accountId },
        'b.com': { id: 'zone_b', name: 'b.com', accountId: ZONE.accountId },
      },
      on: {
        secretPut: async () => {
          if (!holdFirstSecretPut) {
            return;
          }
          holdFirstSecretPut = false;
          await Promise.race([bothSettled, sleep(500)]);
        },
      },
    });
    const first = addDomain(projectA.id, user.jwt, { domain: 'a.com', apiToken: API_TOKEN });
    const second = addDomain(projectB.id, user.jwt, { domain: 'b.com', apiToken: API_TOKEN });
    const bothSettled = Promise.allSettled([first, second]);
    const [firstRes, secondRes] = await Promise.all([first, second]);
    expect(firstRes.status).toBe(201);
    expect(secondRes.status).toBe(201);

    const rowA = (await rowFor(projectA.id, 'a.com'))!;
    const rowB = (await rowFor(projectB.id, 'b.com'))!;
    expect(rowA.status).toBe('active');
    expect(rowB.status).toBe('active');
    // DISTINCT names — first-to-claim, never last-write-wins.
    const names = [rowA.relay_worker_name, rowB.relay_worker_name];
    expect(new Set(names).size).toBe(2);
    expect(names.sort()).toEqual([RELAY_WORKER_BASE_NAME, `${RELAY_WORKER_BASE_NAME}-2`].sort());

    // THE invariant, per domain: the secret on the worker, the row's
    // stored triple, and the proxy mirror's hash are ONE secret.
    for (const [project, domain, row] of [
      [projectA, 'a.com', rowA],
      [projectB, 'b.com', rowB],
    ] as const) {
      const rowHash = await hashEmailRelaySecret(
        await decryptEmailDomainRelaySecret(env, project.id, domain, row),
      );
      expect(stub.secretHashes.get(row.relay_worker_name!)).toBe(rowHash);
      expect((await mirrorFor(domain))!.relaySecretSha256).toBe(rowHash);
    }
  });

  it('409s and revokes the posted grant when the project is marked deleting before setup', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const stub = stubCustomerCf({ zones: { 'acme.com': ZONE } });
    // Pause the route's FIRST transaction — the project-lock + insert tx —
    // before it opens (no locks held yet), so the teardown mark lands
    // first and the locked re-read sees it. The engine can no longer be
    // mid-flight when teardown starts: it runs under this same lock.
    const gate = pauseFirstTransaction(env.db);
    setTestDb(gate.wrappedDb);
    try {
      const resPromise = addDomain(project.id, user.jwt, {
        domain: 'acme.com',
        refreshToken: REFRESH_TOKEN,
      });
      await gate.reached;
      await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));
      gate.release();
      const res = await resPromise;
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('Project is being deleted');
      // Nothing was persisted: no row, no mirror, no CF calls — and the
      // freshly minted grant, whose only copy the CLI drops on an error
      // response, was revoked rather than stranded.
      expect(tags(stub.calls)).toEqual(['oauthRevoke']);
      expect(callsByTag(stub.calls, 'oauthRevoke')[0]!.form!.token).toBe(REFRESH_TOKEN);
      expect(await rowFor(project.id, 'acme.com')).toBeUndefined();
      expect(await mirrorFor('acme.com')).toBeNull();
    } finally {
      setTestDb(env.db);
    }
  });

  it('409s and revokes the posted grant when the project is already being deleted on arrival', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));
    const stub = stubCustomerCf({});

    // The ENTRY guard rejects — the body is parsed before it precisely so
    // this 409 can revoke the grant the CLI drops on the error response.
    const res = await addDomain(project.id, user.jwt, {
      domain: 'acme.com',
      refreshToken: REFRESH_TOKEN,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('Project is being deleted');
    expect(tags(stub.calls)).toEqual(['oauthRevoke']);
    expect(stub.calls[0]!.form!.token).toBe(REFRESH_TOKEN);
    expect(await rowFor(project.id, 'acme.com')).toBeUndefined();
  });

  it('404s and revokes the posted grant when the project is gone', async () => {
    const user = await createTestUser(env.db);
    const stub = stubCustomerCf({});

    // The project guard rejects like every other guard — the CLI drops its
    // only copy of the grant on the 404, so the route revokes it first.
    const res = await addDomain('prj_gone', user.jwt, {
      domain: 'acme.com',
      refreshToken: REFRESH_TOKEN,
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('project not found');
    expect(tags(stub.calls)).toEqual(['oauthRevoke']);
    expect(stub.calls[0]!.form!.token).toBe(REFRESH_TOKEN);
  });

  it('403s and revokes the posted grant when the caller does not own the project', async () => {
    const owner = await createTestUser(env.db);
    const project = await createTestProject(env.db, owner.id);
    const stranger = await createTestUser(env.db);
    const stub = stubCustomerCf({});

    // Possession of the token already authorizes its revocation (RFC 7009 on
    // a public client), so the ownership rejection revokes too — otherwise
    // the CLI drops the grant it minted and nobody kills it.
    const res = await addDomain(project.id, stranger.jwt, {
      domain: 'acme.com',
      refreshToken: REFRESH_TOKEN,
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('forbidden');
    expect(tags(stub.calls)).toEqual(['oauthRevoke']);
    expect(stub.calls[0]!.form!.token).toBe(REFRESH_TOKEN);
    expect(await rowFor(project.id, 'acme.com')).toBeUndefined();
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

  it('serializes concurrent setup retries — the worker secret, row and mirror move together', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    // A row whose setup never finished: both retries re-run the full
    // engine (the branch is decided on the LOCKED row).
    await seedEmailDomain(project.id, 'acme.com', { status: 'failed' });

    // Hold the FIRST engine run at its secret PUT until the other request
    // has settled (or a cap fires) — the maximal-overlap window. The hook
    // touches no db, so holding it inside the serialized section is safe;
    // the queued second request cannot settle, so the cap is what
    // releases the first.
    let holdFirstSecretPut = true;
    const stub = stubCustomerCf({
      zones: { 'acme.com': ZONE },
      failOn: {
        routingDns: { message: 'already enabled', status: 400 },
        onboardSending: { message: 'already exists', status: 409 },
      },
      routingSettings: { enabled: true, status: 'ready' },
      sendingSubdomains: [{ name: 'acme.com', enabled: true }],
      existingScripts: [RELAY_WORKER_BASE_NAME],
      on: {
        secretPut: async () => {
          if (!holdFirstSecretPut) {
            return;
          }
          holdFirstSecretPut = false;
          await Promise.race([bothSettled, sleep(500)]);
        },
      },
    });
    const first = addDomain(project.id, user.jwt, { domain: 'acme.com', apiToken: API_TOKEN });
    const second = addDomain(project.id, user.jwt, { domain: 'acme.com', apiToken: API_TOKEN });
    const bothSettled = Promise.allSettled([first, second]);
    const [firstRes, secondRes] = await Promise.all([first, second]);
    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);

    // THE invariant: the secret on the worker, the row's stored triple,
    // and the proxy mirror's hash are ONE secret. Two UNLOCKED engine
    // runs interleave their secret PUTs and applies — the last PUT is one
    // request's secret, the last apply the other's — and this diverges.
    const row = (await rowFor(project.id, 'acme.com'))!;
    expect(row.status).toBe('active');
    const rowHash = await hashEmailRelaySecret(
      await decryptEmailDomainRelaySecret(env, project.id, 'acme.com', row),
    );
    expect(stub.secretHashes.get(RELAY_WORKER_BASE_NAME)).toBe(rowHash);
    expect((await mirrorFor('acme.com'))!.relaySecretSha256).toBe(rowHash);
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

  it('stamps a posted attemptId on the row and serializes it back', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    stubCustomerCf({ zones: { 'acme.com': ZONE } });

    const res = await addDomain(project.id, user.jwt, {
      domain: 'acme.com',
      apiToken: API_TOKEN,
      attemptId: 'attempt-add-1',
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.attemptId).toBe('attempt-add-1');
    expect((await rowFor(project.id, 'acme.com'))!.attempt_id).toBe('attempt-add-1');
  });

  it('serializes attemptId as null when the add posted none — the old-CLI shape', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    stubCustomerCf({ zones: { 'acme.com': ZONE } });

    const res = await addDomain(project.id, user.jwt, { domain: 'acme.com', apiToken: API_TOKEN });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    // The key is always present — presence is the new-api signal.
    expect(json.attemptId).toBeNull();
    expect((await rowFor(project.id, 'acme.com'))!.attempt_id).toBeNull();
  });

  it('rejects a malformed attemptId and revokes the posted grant', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const stub = stubCustomerCf({ zones: { 'acme.com': ZONE } });

    for (const attemptId of [42, '', 'x'.repeat(129)]) {
      const res = await addDomain(project.id, user.jwt, {
        domain: 'acme.com',
        refreshToken: REFRESH_TOKEN,
        attemptId,
      });
      expect(res.status, JSON.stringify(attemptId)).toBe(400);
    }
    // Every rejection revokes a posted grant — this one included.
    expect(tags(stub.calls)).toEqual(['oauthRevoke', 'oauthRevoke', 'oauthRevoke']);
    expect(await rowFor(project.id, 'acme.com')).toBeUndefined();
  });

  it('re-stamps attempt_id when a re-add replaces the credential', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await addActiveDomain(project.id, user.jwt);
    expect((await rowFor(project.id, 'acme.com'))!.attempt_id).toBeNull();

    stubCustomerCf({
      zones: { 'acme.com': ZONE },
      catchAllRule: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
    });
    const res = await addDomain(project.id, user.jwt, {
      domain: 'acme.com',
      apiToken: API_TOKEN_REPLACEMENT,
      attemptId: 'attempt-readd-1',
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.attemptId).toBe('attempt-readd-1');
    expect((await rowFor(project.id, 'acme.com'))!.attempt_id).toBe('attempt-readd-1');
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
    });
    // Pre-installed: the sentinel fires only on the apply's UPDATE (the
    // checkpoint never writes token_expires_on), so installing it up front
    // fails exactly the apply — with a NON-unique error. The reconciliation's
    // re-read finds the checkpoint-persisted relay NAME but not the
    // apply's relay_version (the checkpoint never writes it), so the
    // row is NOT taken as applied: the orphaned relay is compensated
    // and the original error rethrows.
    await installApplySentinelTrigger();
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
    });
    // Same pre-install: the MX conflict fails setup before any deploy, so
    // the sentinel's first victim is the FAILURE-result apply.
    await installApplySentinelTrigger();
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
    // A public ID may contain `_iv`; only secret field names must be excluded.
    const id = 'edom_ivm16k7p54l5';
    await env.db.update(emailDomains).set({ id }).where(eq(emailDomains.project_id, project.id));

    const res = await listDomains(project.id, user.jwt);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, domain: 'acme.com', status: 'active' });
    expect(JSON.stringify(rows)).not.toContain(API_TOKEN);
    for (const field of [
      'token_ciphertext',
      'token_iv',
      'token_key_version',
      'relay_ciphertext',
      'relay_iv',
      'relay_key_version',
    ]) {
      expect(rows[0]).not.toHaveProperty(field);
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

  it('repairs a drifted mirror from the LOCKED row — a concurrent rotation is not overwritten', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await addActiveDomain(project.id, user.jwt);
    // Force drift: the mirror is missing, so the poll's repair path runs.
    await env.ROUTING.delete('email-domain:acme.com');

    const ROTATED_SECRET = 'relay-secret-rotated-dummy';
    stubCustomerCf({
      zones: { 'acme.com': ZONE },
      existingScripts: [RELAY_WORKER_BASE_NAME],
      catchAllRule: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
      on: {
        // The catch-all probe runs AFTER the route's row snapshot was read
        // and BEFORE the repair: a concurrent sync rotating the relay
        // secret and republishing the mirror lands exactly in the repair's
        // race window. No transaction is open during the probes, so these
        // writes are safe.
        catchAllGet: async () => {
          const rotated = await encryptEmailDomainRelaySecret(
            env,
            project.id,
            'acme.com',
            ROTATED_SECRET,
          );
          await env.db
            .update(emailDomains)
            .set({
              relay_ciphertext: rotated.ciphertext,
              relay_iv: rotated.iv,
              relay_key_version: rotated.keyVersion,
            })
            .where(eq(emailDomains.domain, 'acme.com'));
          await writeEmailDomainMirror(
            env.ROUTING,
            (await rowFor(project.id, 'acme.com'))!,
            await hashEmailRelaySecret(ROTATED_SECRET),
          );
        },
      },
    });
    const res = await domainStatus(project.id, 'acme.com', user.jwt);
    expect(res.status).toBe(200);

    // The mirror converges to the ROTATED secret: the repair re-reads the
    // row under the lock, finds the republished mirror already matching,
    // and writes nothing. Writing from the route's stale snapshot would
    // restore the pre-rotation hash — inbound would reject every message.
    expect((await mirrorFor('acme.com'))!.relaySecretSha256).toBe(
      await hashEmailRelaySecret(ROTATED_SECRET),
    );
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

  it('refuses the sync when teardown marks the project deleting before the lock', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await addActiveDomain(project.id, user.jwt);
    const before = (await rowFor(project.id, 'acme.com'))!;
    const beforeMirror = (await mirrorFor('acme.com'))!;

    // Teardown's status flip lands between the route's entry guard and
    // the serialized section: the in-transaction project recheck must
    // refuse the sync — otherwise the relay would be redeployed and the
    // mirror republished AFTER teardown cleared them, and the cascade
    // would delete the row, leaving a recreated mirror, worker and
    // catch-all with no database handle.
    const realDb = env.db;
    const gate = pauseFirstTransaction(realDb);
    setTestDb(gate.wrappedDb);
    try {
      const stub = stubCustomerCf({ zones: { 'acme.com': ZONE } });
      const reqPromise = syncDomain(project.id, 'acme.com', user.jwt);
      await gate.reached;
      await realDb.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));
      gate.release();

      const res = await reqPromise;
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'Project is being deleted' });
      // Refused before the engine ran — no CF call, no mirror write.
      expect(stub.calls).toEqual([]);
      const after = (await rowFor(project.id, 'acme.com'))!;
      expect(after.relay_ciphertext).toBe(before.relay_ciphertext);
      expect(after.status).toBe(before.status);
      expect((await mirrorFor('acme.com'))!.relaySecretSha256).toBe(beforeMirror.relaySecretSha256);
    } finally {
      setTestDb(realDb);
    }
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

  it('serializes a lease refresh behind the removal — the revoke submits the live head', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const row = await seedEmailDomain(project.id, 'acme.com', {
      status: 'active',
      credentialKind: 'oauth_grant',
      credential: REFRESH_TOKEN,
    });

    // The removal holds the row lock across the cleanup, so a lease
    // refresh fired mid-cleanup cannot interleave: its transaction queues
    // behind the removal's and finds the row gone afterwards. Fired
    // without awaiting inside the hook — awaiting would deadlock PGlite's
    // single connection against the removal's open transaction.
    let leaseAttempt: Promise<'refreshed' | unknown> | undefined;
    const stub = stubCustomerCf({
      catchAllRule: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
      on: {
        catchAllGet: () => {
          leaseAttempt = refreshOauthGrantSerialized(env.db, env, row.id).then(
            () => 'refreshed' as const,
            (err: unknown) => err,
          );
        },
      },
    });
    const res = await removeDomain(project.id, 'acme.com', user.jwt);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: true });
    // One rotation (the removal's own); the lease's token call could not
    // have interleaved — its transaction had not started yet.
    expect(tags(stub.calls)).toEqual([
      'oauthToken',
      'catchAllGet',
      'catchAll',
      'scriptDelete',
      'oauthRevoke',
    ]);
    const revocations = callsByTag(stub.calls, 'oauthRevoke');
    expect(revocations).toHaveLength(1);
    // The removal's own rotation IS the live head at revoke time — the
    // lock makes the round-2 interleaving impossible, so revoking it
    // kills the chain.
    expect(revocations[0]!.form!.token).toBe('cf-rotated-refresh-dummy-1');
    // The queued refresh ran after the commit and found the row gone.
    const leaseOutcome = await leaseAttempt;
    expect(leaseOutcome).toBeInstanceOf(Error);
    expect(String(leaseOutcome)).toContain('vanished mid-refresh');
    expect(await rowFor(project.id, 'acme.com')).toBeUndefined();
    expect(await mirrorFor('acme.com')).toBeNull();
  });

  it('revokes the replacement credential when a replace commits before the removal lock', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await addActiveDomain(project.id, user.jwt);
    const row = (await rowFor(project.id, 'acme.com'))!;

    // A replace committing an oauth_grant between the DELETE's entry read
    // and its row lock: the removal must clean up with the credential the
    // row holds at LOCK time — and revoke that grant — never delete the
    // row over a stale api_token snapshot and orphan the grant (the
    // replace never invalidates an old api_token, so the stale cleanup
    // would have SUCCEEDED).
    const realDb = env.db;
    const gate = pauseFirstTransaction(realDb);
    setTestDb(gate.wrappedDb);
    try {
      const stub = stubCustomerCf({
        catchAllRule: { enabled: true, workerName: RELAY_WORKER_BASE_NAME },
      });
      const reqPromise = Promise.resolve(removeDomain(project.id, 'acme.com', user.jwt));
      const winner = await Promise.race([
        gate.reached.then(() => 'tx' as const),
        reqPromise.then(() => 'request' as const),
      ]);
      if (winner === 'tx') {
        // The replace's commit lands while the removal waits for the lock.
        const enc = await encryptEmailDomainToken(env, project.id, 'acme.com', REFRESH_TOKEN);
        await realDb
          .update(emailDomains)
          .set({
            credential_kind: 'oauth_grant',
            token_ciphertext: enc.ciphertext,
            token_iv: enc.iv,
            token_key_version: enc.keyVersion,
            token_id: null,
            token_expires_on: null,
          })
          .where(eq(emailDomains.id, row.id));
        gate.release();
      }
      const res = await reqPromise;
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, removed: true });
      // The cleanup ran with the replacement grant — refreshed through
      // the row, revoked LAST — not orphaned by the row delete.
      expect(tags(stub.calls)).toEqual([
        'oauthToken',
        'catchAllGet',
        'catchAll',
        'scriptDelete',
        'oauthRevoke',
      ]);
      expect(await rowFor(project.id, 'acme.com')).toBeUndefined();
      expect(await mirrorFor('acme.com')).toBeNull();
    } finally {
      setTestDb(realDb);
    }
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

  it('fences the revoked mirror write against a replace that committed first', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await seedEmailDomain(project.id, 'acme.com', {
      status: 'active',
      credentialKind: 'oauth_grant',
      credential: REFRESH_TOKEN,
    });
    const oldHash = (await mirrorFor('acme.com'))!.relaySecretSha256;

    // A's refresh gets invalid_grant (committing token_revoked); B's
    // api_token replace + sync never touches the OAuth token endpoint, so
    // one stub covers both requests.
    stubCustomerCf({ zones: { 'acme.com': ZONE }, oauth: 'invalid_grant' });

    // Park the lease route's SECOND transaction — the fenced mirror write —
    // so B's replace commits and publishes its active mirror in between.
    const realDb = env.db;
    const gate = pauseNthTransaction(realDb, 2);
    setTestDb(gate.wrappedDb);
    try {
      const reqPromise = leaseCredential('acme.com');
      const parked = await Promise.race([
        gate.reached.then(() => 'parked' as const),
        reqPromise.then(() => 'settled' as const),
      ]);
      // The mirror write must be a transaction of its own: unfenced, the
      // request settles without one and its stale write can land last.
      expect(parked).toBe('parked');

      try {
        const replaceRes = await addDomain(project.id, user.jwt, {
          domain: 'acme.com',
          apiToken: API_TOKEN_REPLACEMENT,
        });
        expect(replaceRes.status).toBe(200);
      } finally {
        gate.release();
      }

      // The caller's answer is unchanged: the grant the lease refreshed
      // was revoked, even though the row has since been replaced.
      const res = await reqPromise;
      expect(res.status).toBe(403);

      // The replacement's under-lock publication is authoritative: no
      // token_revoked write with the pre-rotation hash landed after it.
      const row = (await rowFor(project.id, 'acme.com'))!;
      expect(row.status).toBe('active');
      const mirror = (await mirrorFor('acme.com'))!;
      expect(mirror.status).toBe('active');
      expect(mirror.relaySecretSha256).toBe(
        await hashEmailRelaySecret(
          await decryptEmailDomainRelaySecret(env, project.id, 'acme.com', row),
        ),
      );
      expect(mirror.relaySecretSha256).not.toBe(oldHash);
    } finally {
      setTestDb(realDb);
    }
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
