/**
 * Relay engine — the add / sync / remove orchestration for one
 * `email_domains` row against the customer's Cloudflare account (design
 * doc 0078, "The flow", and task contract 7). Pure-ish: every function
 * takes the row plus an injectable customer-CF client and RETURNS the row
 * fields to persist. The caller (the domains routes) owns the DB write,
 * the ROUTING KV mirror, and all encryptProjectSecret work.
 *
 * Step order for setup: verify credential (api_token → /user/tokens/verify,
 * oauth_grant → one refresh round-trip) → zone lookup (GET /zones?name=,
 * walking the labels up to the registrable zone; also yields account_id) →
 * MX check over public DNS (decides apex vs subdomain) → enable routing
 * (POST routing/dns; empty body for apex, { name } for a subdomain) →
 * onboard sending → claim the relay name → deploy relay + secret →
 * catch-all → active.
 *
 * Setup is re-runnable — re-adding a `failed` row re-executes it against
 * the row's recorded progress: a recorded mode skips the MX check (the
 * first attempt's enable_routing put OUR MX on the domain, so a fresh
 * lookup would fail on records we created), a recorded relay name
 * redeploys in place (a name-walk would orphan the first relay under a
 * fresh '-2'), and an 'already done' 400/409 from enable_routing /
 * onboard_sending is believed ONLY when a read-back of the actual zone
 * state confirms it — never on the status code alone. The catch-all is
 * never written blind: it is zone-scoped with no domain parameter, so one
 * PUT can hijack another domain's (or another tool's) inbound. Setup
 * reads it first and refuses to overwrite an enabled rule it does not
 * own; remove resets it only when it still names this row's relay.
 *
 * A persistProgress dep makes setup deliberately NON-total: the
 * checkpoint fires once after the relay deploy and before the catch-all
 * write, and its throw PROPAGATES so the route can abort setup when the
 * mid-setup row persist fails. Dep-free calls keep today's totality —
 * every failure still lands in the returned row fields.
 *
 * A claimRelayName dep reserves the walked relay name on the caller's own
 * row BEFORE any CF upload (the route implements it as an UPDATE inside
 * its serialized transaction): two setups racing one customer account
 * serialize on the (account_id, relay_worker_name) unique index, so the
 * loser's walk advances past the contested name instead of overwriting
 * the winner's worker — first-to-claim, never last-write-wins. The dep
 * is REQUIRED when the row carries no relay_worker_name: the walk throws
 * without it rather than falling back to a CF-only probe, which would
 * silently re-open that race.
 *
 * Failure rules:
 *   - Every orchestration failure leaves status 'failed' with
 *     setup_state.failed_step naming the step. Fields learned before the
 *     failure (zone_id, account_id, mode, …) are still returned so the row
 *     records how far it got.
 *   - A subdomain routing POST that fails is NOT a failure: that endpoint
 *     has no guaranteed token path (probe 8), so the dashboard form stays
 *     as the documented human step. It lands in
 *     setup_state.remaining_steps and the row stays 'pending'.
 *   - A dead credential maps to its own status: 'token_expired' /
 *     'token_revoked' (contract 4's invalid_grant mapping included), never
 *     a bare 'failed'.
 *   - rotated_refresh_token is returned on EVERY outcome once a refresh
 *     happened — grant refresh tokens are single-use, so dropping the
 *     rotated value would kill the chain. The caller re-encrypts it into
 *     the token_* triple in the same transaction as the row update.
 *
 * `error` is for logs only and is never secret material: CF/OAuth error
 * text names the failing field or grant code, not the credential values.
 */

import { CloudflareApiError } from '../provisioning/cloudflare-api.ts';
import type { EmailDomainSetupState } from '../schema.ts';
import { OAuthGrantError, createCfCustomerClient, refreshOauthGrant } from './cf-customer.ts';
import type {
  CfCustomerClient,
  CfCustomerZone,
  CfTokenVerification,
  OauthGrantTokens,
} from './cf-customer.ts';
import { generateEmailRelaySecret } from './domains.ts';
import type { EmailDomain } from './domains.ts';
import { RELAY_COMPATIBILITY_DATE, RELAY_SOURCE, RELAY_VERSION } from './relay-worker.ts';

/** Base name for the relay worker; collisions within the account gain '-2', '-3'… */
export const RELAY_WORKER_BASE_NAME = 'void-email-relay';

/** Human step recorded when the subdomain routing POST is refused. */
export const ROUTING_SUBDOMAIN_STEP = 'routing_subdomain';

/**
 * Plan step recorded when Email Sending onboarding is refused for
 * entitlement (CF error codes 2036/10105 — Workers Free). Unlike
 * routing_subdomain it is NOT inbound-blocking: Email Routing works on
 * Free, so the relay and catch-all still deploy and the row can go
 * active with this step recorded. Only the outbound lane (send_raw)
 * stays refused until a plan upgrade; a sync re-attempts the onboarding
 * POST, and the status GET self-clears the step on a confirming
 * read-back.
 */
export const SENDING_ONBOARDING_STEP = 'sending_onboarding';

/** CF's entitlement refusal for Email Sending on a Workers Free account. */
function isSendingEntitlementRefusal(err: unknown): boolean {
  return (
    err instanceof CloudflareApiError && (err.codes.includes(2036) || err.codes.includes(10105))
  );
}

const MAX_RELAY_NAME_SUFFIX = 50;

export type RelayEngineDeps = Readonly<{
  /** Builds a client bound to one credential; the oauth_grant path is called with the refreshed access token. */
  createClient?: (credential: string) => CfCustomerClient;
  /** One refresh round-trip; defaults to the real OAuth token endpoint. */
  refreshGrant?: (refreshToken: string) => Promise<OauthGrantTokens>;
  /**
   * RFC 7009 grant revocation (remove path only). Takes no token: the
   * closure revokes the row's LIVE chain head (the serialized helper) — a
   * token captured earlier may already be consumed by an interleaved
   * refresh, and CF answers 200 for a consumed token either way.
   * Deliberately has NO default: a caller that leaves its row alive must
   * not revoke, so the engine revokes only when the caller explicitly
   * supplies this.
   */
  revokeGrant?: () => Promise<void>;
  /** Public-DNS MX lookup; defaults to DNS-over-HTTPS against cloudflare-dns.com. */
  lookupMx?: (domain: string) => Promise<ReadonlyArray<string>>;
  /** Relay secret generator (sync rotation); defaults to generateEmailRelaySecret. */
  generateRelaySecret?: () => string;
  /**
   * Relay-name reservation for setup's name-walk: claims
   * (accountId, candidate) on the caller's OWN row, inside the caller's
   * serialized transaction (the route implements it with the same
   * savepoint machinery as the deploy checkpoint). 'taken' means another
   * row holds the name — the walk advances to the next suffix. Blocking
   * semantics come from the (account_id, relay_worker_name) partial
   * unique index: a concurrent claim waits on the winner's uncommitted
   * UPDATE, then either proceeds (winner rolled back) or reports taken
   * (winner committed) — one-directional, so no deadlock. REQUIRED
   * whenever the row carries no relay_worker_name: the walk throws
   * without it rather than probing CF alone, which would silently
   * re-open the last-write-wins relay race. Never called on an in-place
   * redeploy (the row already holds a name).
   */
  claimRelayName?: (accountId: string, candidate: string) => Promise<'claimed' | 'taken'>;
  /**
   * Mid-setup progress checkpoint (setup only), fired ONCE right after
   * the relay deploy + secret PUT succeed and BEFORE the catch-all write,
   * with the seeded/learned zone/account/mode and the deployed relay
   * name. Skipped on an in-place redeploy — a row that already carries
   * relay_worker_name already knows. A throw PROPAGATES: with this dep
   * supplied, setup is deliberately no longer total (the route relies on
   * the throw to abort before the catch-all write); dep-free calls keep
   * today's totality.
   */
  persistProgress?: (
    progress: Readonly<{
      zone_id: string | null;
      account_id: string | null;
      mode: 'apex' | 'subdomain' | null;
      relay_worker_name: string;
    }>,
  ) => Promise<void>;
}>;

export type EmailDomainSetupInput = Readonly<{
  /**
   * domain + credential_kind always; mode + relay_worker_name + zone_id +
   * account_id only on a re-run of a row that already got that far. They
   * make the re-run idempotent (the header's re-runnable paragraph) AND
   * they are seeded into the returned progress, so a re-run that fails
   * EARLY (a dead credential) never erases what the row already learned —
   * the next retry still skips the MX check and still knows its relay.
   */
  row: Pick<EmailDomain, 'domain' | 'credential_kind'> &
    Partial<Pick<EmailDomain, 'mode' | 'relay_worker_name' | 'zone_id' | 'account_id'>>;
  /** Decrypted credential: the pasted API token, or the grant's refresh token. */
  credential: string;
  /** Decrypted relay secret, handed to the relay worker as VOID_RELAY_SECRET. */
  relaySecret: string;
  /** Baked into the relay as the VOID_PROXY_ORIGIN plain-text var. */
  proxyOrigin: string;
}>;

export type EmailDomainSyncInput = Readonly<{
  row: Pick<EmailDomain, 'domain' | 'credential_kind' | 'account_id' | 'relay_worker_name'> &
    // zone_id drives the catch-all ensure; absent/null → the ensure is
    // skipped entirely (older callers pass no zone).
    Partial<Pick<EmailDomain, 'zone_id'>> & {
      /**
       * The row's recorded remaining steps. When sending_onboarding is
       * among them (a Workers Free refusal at setup), sync RE-ATTEMPTS
       * the onboarding POST after the catch-all ensure — the post-plan-
       * upgrade completion path — and reports it in cleared_steps.
       */
      setup_remaining_steps?: ReadonlyArray<string>;
    };
  credential: string;
  proxyOrigin: string;
}>;

export type EmailDomainRemoveInput = Readonly<{
  row: Pick<EmailDomain, 'credential_kind' | 'account_id' | 'relay_worker_name' | 'zone_id'>;
  credential: string;
  /**
   * Conflict-compensation repoint target — the relay worker of the row
   * that WON this zone. When set AND ≠ this row's own relay name, an
   * owned catch-all is REPOINTED at the winner instead of reset, so the
   * zone's inbound keeps working. Absent (or naming this row's own
   * relay) → the plain reset path.
   */
  repoint_catch_all_to?: string;
}>;

/** The row-field update the caller persists; snake_case matches the drizzle columns. */
export type EmailDomainSetupResult = Readonly<{
  status: EmailDomain['status'];
  zone_id: string | null;
  account_id: string | null;
  mode: EmailDomain['mode'];
  relay_worker_name: string | null;
  relay_version: number | null;
  token_id: string | null;
  token_expires_on: string | null;
  setup_state: EmailDomainSetupState | null;
  rotated_refresh_token?: string;
  error?: string;
}>;

export type EmailDomainSyncResult = Readonly<{
  status: EmailDomain['status'];
  relay_version: number | null;
  setup_state: EmailDomainSetupState | null;
  /**
   * The catch-all ensure outcome — present only when the row carries a
   * zone_id AND the redeploy succeeded:
   *   - 'ensured' — a missing, disabled, or non-worker rule was
   *     (re-)pointed at this row's relay;
   *   - 'already_set' — the enabled rule already named this row's relay;
   *   - 'foreign_conflict' — an ENABLED rule names a DIFFERENT worker:
   *     reported, never overwritten (the drift doctrine: report, don't
   *     fight);
   *   - 'probe_failed' — the ownership read or the write failed;
   *     non-fatal, the redeploy/rotation still succeeded.
   */
  catch_all?: 'ensured' | 'already_set' | 'foreign_conflict' | 'probe_failed';
  /**
   * Remaining steps the sync itself completed (the sending-onboarding
   * retry) — the caller subtracts them from the row's recorded
   * remaining_steps instead of carrying them verbatim.
   */
  cleared_steps?: ReadonlyArray<string>;
  /** Fresh relay secret — the caller re-encrypts it into relay_* and sha256s it into the mirror. */
  new_relay_secret?: string;
  rotated_refresh_token?: string;
  error?: string;
}>;

export type EmailDomainRemoveResult = Readonly<{
  /** CF-side steps that failed. Removal of the row and mirror key proceeds regardless. */
  failed_steps: ReadonlyArray<string>;
}>;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const defaultCreateClient = (credential: string): CfCustomerClient =>
  createCfCustomerClient(credential);

/**
 * Default MX check: DNS-over-HTTPS against cloudflare-dns.com's JSON API.
 * Returns the MX exchange hostnames (priority and trailing dot stripped).
 * Public DNS — no credential involved.
 */
async function lookupMxOverDns(domain: string): Promise<ReadonlyArray<string>> {
  const response = await fetch(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`,
    { headers: { accept: 'application/dns-json' } },
  );
  if (!response.ok) {
    throw new Error(`public DNS MX lookup failed with HTTP ${response.status}`);
  }
  const json = (await response.json()) as {
    Answer?: ReadonlyArray<{ type: number; data: string }>;
  };
  return (json.Answer ?? [])
    .filter((answer) => answer.type === 15)
    .map((answer) => answer.data.trim().split(/\s+/).slice(1).join(' ').replace(/\.$/, ''));
}

/**
 * The enable_routing idempotency read-back: GET email/routing's `enabled`
 * (a required boolean in the API schema). False on any failure or
 * unparseable shape — the caller then surfaces the original POST error.
 */
async function routingEnabledReadback(client: CfCustomerClient, zoneId: string): Promise<boolean> {
  try {
    const settings = await client.getRoutingSettings(zoneId);
    return (
      settings !== null &&
      typeof settings === 'object' &&
      (settings as { enabled?: unknown }).enabled === true
    );
  } catch {
    return false;
  }
}

/**
 * The onboard_sending idempotency read-back: the sending-subdomain list
 * carries an entry named for the email domain with `enabled` true. False
 * on any failure — fail-closed, like routingEnabledReadback. Whether the
 * ZONE APEX itself appears in this list is unpinned (probe 8), so an
 * apex re-run whose onboard actually succeeded may still fail with the
 * original CF error; the message names the step either way.
 */
export async function sendingOnboardedReadback(
  client: CfCustomerClient,
  zoneId: string,
  domain: string,
): Promise<boolean> {
  try {
    const subdomains = await client.listSendingSubdomains(zoneId);
    return subdomains.some(
      (subdomain) => subdomain.enabled && subdomain.name.toLowerCase() === domain.toLowerCase(),
    );
  } catch {
    return false;
  }
}

/**
 * The status route's self-clear probe for the routing-subdomain human
 * step: the dashboard form's observable effect is public MX records
 * naming Cloudflare's inbound exchanges (route1..3.mx.cloudflare.net).
 * False on lookup failure — a pending row simply stays pending and the
 * next status poll retries.
 */
export async function domainHasRoutingMx(domain: string): Promise<boolean> {
  try {
    const mx = await lookupMxOverDns(domain);
    return mx.some((exchange) => exchange.toLowerCase().endsWith('.mx.cloudflare.net'));
  } catch {
    return false;
  }
}

type CredentialResolution =
  | Readonly<{
      ok: true;
      client: CfCustomerClient;
      token_id: string | null;
      token_expires_on: string | null;
      rotated_refresh_token?: string;
    }>
  | Readonly<{ ok: false; status: 'failed' | 'token_revoked' | 'token_expired'; error: string }>;

/**
 * Setup step 1. api_token rows verify via GET /user/tokens/verify (which
 * also yields token_id/expires_on for `status` output); oauth_grant rows
 * verify by running one refresh round-trip and continuing on the fresh
 * access token.
 */
async function resolveCredential(
  credentialKind: EmailDomain['credential_kind'],
  credential: string,
  deps: RelayEngineDeps,
): Promise<CredentialResolution> {
  const createClient = deps.createClient ?? defaultCreateClient;
  if (credentialKind === 'api_token') {
    const client = createClient(credential);
    let verification: CfTokenVerification;
    try {
      verification = await client.verifyToken();
    } catch (err) {
      return { ok: false, status: 'failed', error: errorMessage(err) };
    }
    if (verification.status === 'expired') {
      return { ok: false, status: 'token_expired', error: 'the Cloudflare API token is expired' };
    }
    if (verification.status !== 'active') {
      return {
        ok: false,
        status: 'token_revoked',
        error: `the Cloudflare API token is ${verification.status}, not active`,
      };
    }
    return {
      ok: true,
      client,
      token_id: verification.id,
      token_expires_on: verification.expires_on ?? null,
    };
  }
  let tokens: OauthGrantTokens;
  try {
    tokens = await (deps.refreshGrant ?? refreshOauthGrant)(credential);
  } catch (err) {
    if (err instanceof OAuthGrantError && err.code === 'invalid_grant') {
      return {
        ok: false,
        status: 'token_revoked',
        error: 'the Cloudflare OAuth grant was revoked',
      };
    }
    return { ok: false, status: 'failed', error: errorMessage(err) };
  }
  return {
    ok: true,
    client: createClient(tokens.accessToken),
    token_id: null,
    token_expires_on: null,
    rotated_refresh_token: tokens.refreshToken,
  };
}

export async function setupEmailDomain(
  input: EmailDomainSetupInput,
  deps: RelayEngineDeps = {},
): Promise<EmailDomainSetupResult> {
  const lookupMx = deps.lookupMx ?? lookupMxOverDns;
  // Seed from the row on a re-run: a failure before the step that re-learns
  // a value must still return the recorded one, or a dead-credential retry
  // would erase the row's progress (see the input contract).
  const progress = {
    zone_id: input.row.zone_id ?? null,
    account_id: input.row.account_id ?? null,
    mode: input.row.mode ?? null,
    relay_worker_name: input.row.relay_worker_name ?? null,
    token_id: null as string | null,
    token_expires_on: null as string | null,
  };
  const remainingSteps: Array<string> = [];

  // Step 1: verify the credential.
  const resolved = await resolveCredential(input.row.credential_kind, input.credential, deps);
  // Carried on every outcome — grant refresh tokens are single-use, so a
  // failure after a successful refresh must still return the rotated value
  // for the caller to persist (see the header).
  const rotatedRefreshToken: string | undefined = resolved.ok
    ? resolved.rotated_refresh_token
    : undefined;

  const failWith = (
    status: 'failed' | 'token_revoked' | 'token_expired',
    step: string,
    message: string,
  ): EmailDomainSetupResult => ({
    status,
    ...progress,
    relay_version: null,
    setup_state: {
      failed_step: step,
      ...(remainingSteps.length > 0 ? { remaining_steps: remainingSteps } : {}),
    },
    ...(rotatedRefreshToken === undefined ? {} : { rotated_refresh_token: rotatedRefreshToken }),
    error: message,
  });
  const fail = (step: string, err: unknown): EmailDomainSetupResult =>
    failWith('failed', step, errorMessage(err));

  if (!resolved.ok) {
    return failWith(resolved.status, 'verify_credential', resolved.error);
  }
  progress.token_id = resolved.token_id;
  progress.token_expires_on = resolved.token_expires_on;
  const client = resolved.client;

  // Step 2: zone lookup. The zone is the deepest suffix of the email
  // domain that exists as a zone in an account the credential can see
  // (mail.acme.com → acme.com, or the subdomain itself on an Enterprise
  // subdomain setup). Also yields account_id.
  const labels = input.row.domain.split('.');
  let zone: CfCustomerZone | null = null;
  for (let start = 0; start <= labels.length - 2 && !zone; start++) {
    const candidate = labels.slice(start).join('.');
    try {
      zone = await client.findZone(candidate);
    } catch (err) {
      return fail('zone_lookup', err);
    }
  }
  if (!zone) {
    return failWith(
      'failed',
      'zone_lookup',
      `no Cloudflare zone found for ${input.row.domain} in an account this credential can see`,
    );
  }
  progress.zone_id = zone.id;
  progress.account_id = zone.account.id;

  // Step 3: MX check over public DNS. A domain already carrying MX has a
  // mail setup Email Routing would fight — apex or subdomain alike. Only
  // an MX-empty zone apex takes the apex path; anything else must be a
  // subdomain (the CLI proposes mail.<apex> up front). Skipped on a
  // re-run: the first attempt's enable_routing put OUR MX on the domain,
  // and the recorded mode stands.
  if (input.row.mode) {
    progress.mode = input.row.mode;
  } else {
    let mx: ReadonlyArray<string>;
    try {
      mx = await lookupMx(input.row.domain);
    } catch (err) {
      return fail('mx_check', err);
    }
    if (mx.length > 0) {
      return failWith(
        'failed',
        'mx_check',
        `${input.row.domain} already carries MX (${mx.join(', ')}) — add a subdomain such as mail.${zone.name} instead`,
      );
    }
    progress.mode =
      input.row.domain.toLowerCase() === zone.name.toLowerCase() ? 'apex' : 'subdomain';
  }

  // Step 4: enable Email Routing.
  if (progress.mode === 'apex') {
    try {
      await client.enableRouting(zone.id);
    } catch (err) {
      // A re-run re-POSTs over the first attempt's success. A 400/409 is
      // 'already enabled' ONLY when the settings read-back agrees —
      // anything else is the original error (fail-closed).
      if (
        !(
          err instanceof CloudflareApiError &&
          (err.status === 400 || err.status === 409) &&
          (await routingEnabledReadback(client, zone.id))
        )
      ) {
        return fail('enable_routing', err);
      }
    }
  } else {
    try {
      await client.enableRouting(zone.id, input.row.domain);
    } catch {
      // No guaranteed token path (probe 8) — the dashboard form is the
      // documented fallback. Record the human step and finish the rest.
      remainingSteps.push(ROUTING_SUBDOMAIN_STEP);
    }
  }

  // Step 5: onboard sending (cf-bounce MX, SPF, DKIM, DMARC). Same
  // re-run read-back as step 4, through the sending-subdomain list. An
  // ENTITLEMENT refusal (Workers Free) is not fatal: Email Routing needs
  // no paid plan, so the inbound lane deploys anyway and the step is
  // recorded for a post-upgrade sync — only the outbound lane (send_raw)
  // stays refused at CF until then.
  try {
    await client.onboardSending(zone.id, input.row.domain);
  } catch (err) {
    if (isSendingEntitlementRefusal(err)) {
      remainingSteps.push(SENDING_ONBOARDING_STEP);
    } else if (
      !(
        err instanceof CloudflareApiError &&
        (err.status === 400 || err.status === 409) &&
        (await sendingOnboardedReadback(client, zone.id, input.row.domain))
      )
    ) {
      return fail('onboard_sending', err);
    }
  }

  // Step 6: pick a free relay name — or reuse the recorded one, since a
  // re-run redeploys IN PLACE (the name-walk would take a fresh '-2' and
  // orphan the first relay; renaming detaches routing rules). A walked
  // name is CLAIMED on the row via the claimRelayName dep BEFORE the
  // upload, so two setups racing one account can't both deploy the same
  // name (see claimFreeRelayName). The name lands in progress the moment
  // it is chosen, BEFORE the fallible writes: a failed upload or secret
  // PUT then still records it on the row, so a retry redeploys in place
  // and a remove can find the worker — an unrecorded upload would leak
  // it and walk the next retry to '-2'.
  let relayWorkerName: string;
  try {
    relayWorkerName =
      input.row.relay_worker_name ??
      (await claimFreeRelayName(client, zone.account.id, deps.claimRelayName));
  } catch (err) {
    return fail('deploy_relay', err);
  }
  progress.relay_worker_name = relayWorkerName;
  try {
    await client.putRelayScript(zone.account.id, relayWorkerName, {
      source: RELAY_SOURCE,
      compatibilityDate: RELAY_COMPATIBILITY_DATE,
      proxyOrigin: input.proxyOrigin,
      emailDomain: input.row.domain,
    });
    await client.putRelaySecret(zone.account.id, relayWorkerName, input.relaySecret);
  } catch (err) {
    return fail('deploy_relay', err);
  }

  // Checkpoint: let the caller persist the mid-setup progress BEFORE the
  // catch-all write, so a failed row persist aborts setup here rather
  // than after a zone-scoped rule was written. Fresh deploys only — an
  // in-place redeploy means the row already carries the relay name. A dep
  // throw PROPAGATES by design (see RelayEngineDeps.persistProgress).
  if (deps.persistProgress && !input.row.relay_worker_name) {
    await deps.persistProgress({
      zone_id: progress.zone_id,
      account_id: progress.account_id,
      mode: progress.mode,
      relay_worker_name: relayWorkerName,
    });
  }

  // Step 7: point the zone's catch-all at the relay — but only after an
  // ownership read. The catch-all is zone-scoped with no domain
  // parameter: a blind PUT can hijack another domain's (or another
  // tool's) inbound. An enabled rule naming anything but our relay is a
  // conflict; one already naming our relay is a re-run — nothing to write.
  let catchAllAlreadyOurs = false;
  try {
    const existing = await client.getCatchAll(zone.id);
    if (existing && existing.enabled) {
      if (existing.workerName === relayWorkerName) {
        catchAllAlreadyOurs = true;
      } else {
        return failWith(
          'failed',
          'catch_all',
          existing.workerName === null
            ? `the zone catch-all for ${zone.name} is enabled with a non-worker action — disable it in the Cloudflare dashboard first`
            : `the zone catch-all for ${zone.name} already routes to worker '${existing.workerName}' — one zone routes one email domain; remove the other domain first`,
        );
      }
    }
  } catch (err) {
    return fail('catch_all', err);
  }
  if (!catchAllAlreadyOurs) {
    try {
      await client.setCatchAll(zone.id, relayWorkerName);
    } catch (err) {
      return fail('catch_all', err);
    }
  }

  return {
    // Only an inbound-blocking step holds the row at 'pending': a lone
    // sending_onboarding step leaves inbound live (the proxy gates on the
    // mirror's active status), with outbound refused at CF until a plan
    // upgrade and a sync complete it.
    status: remainingSteps.includes(ROUTING_SUBDOMAIN_STEP) ? 'pending' : 'active',
    ...progress,
    relay_version: RELAY_VERSION,
    setup_state: remainingSteps.length > 0 ? { remaining_steps: remainingSteps } : null,
    ...(rotatedRefreshToken === undefined ? {} : { rotated_refresh_token: rotatedRefreshToken }),
  };
}

/**
 * Setup step 6's name-walk: the base name, then '-2', '-3'… on collision
 * within the account (a second registered domain of the same customer).
 * Each candidate is CF-probed first — a physically occupied name (an
 * orphan, or a worker the customer created out-of-band) is skipped
 * without spending a claim — then CLAIMED via the claimRelayName dep
 * BEFORE any upload: two setups racing one account serialize on the
 * (account_id, relay_worker_name) unique index, so a concurrent claim
 * either blocks past the winner's commit and 23505s ('taken' — the walk
 * advances) or proceeds past its rollback. First-to-claim wins; the
 * loser's walk never writes the contested worker. The dep is REQUIRED —
 * a CF-only walk would re-open exactly that race. The caller records the
 * chosen name before any fallible write; the name is stable once chosen
 * — renaming a worker detaches every routing rule pointing at it, so
 * sync redeploys in place and never re-walks.
 */
async function claimFreeRelayName(
  client: CfCustomerClient,
  accountId: string,
  claimRelayName: RelayEngineDeps['claimRelayName'],
): Promise<string> {
  if (!claimRelayName) {
    throw new Error(
      'the claimRelayName dep is required when setup walks relay names (the row carries none)',
    );
  }
  for (let suffix = 1; suffix <= MAX_RELAY_NAME_SUFFIX; suffix++) {
    const candidate = suffix === 1 ? RELAY_WORKER_BASE_NAME : `${RELAY_WORKER_BASE_NAME}-${suffix}`;
    if (await client.relayScriptExists(accountId, candidate)) {
      continue;
    }
    if ((await claimRelayName(accountId, candidate)) === 'claimed') {
      return candidate;
    }
  }
  throw new Error(
    `no free relay worker name in this account (${RELAY_WORKER_BASE_NAME}-1..${MAX_RELAY_NAME_SUFFIX} all taken)`,
  );
}

/**
 * `void email domain sync`: redeploy the relay in place at the current
 * RELAY_VERSION and rotate its secret. Rotation is overwrite, never
 * read-compare (worker secrets are write-only). The caller re-encrypts the
 * new secret and updates the KV mirror's sha256; inbound is rejected
 * between the secret PUT and the mirror update, so sync re-mirrors
 * immediately after.
 *
 * When the row carries a zone_id, sync also ENSURES the zone catch-all
 * after a successful redeploy: a missing, disabled, or non-worker rule is
 * (re-)pointed at this row's relay ('ensured'), and an enabled rule
 * already naming it is left alone ('already_set'). An ENABLED rule naming
 * a DIFFERENT worker is reported ('foreign_conflict'), never overwritten
 * — the drift doctrine is report, don't fight. A failed probe or write
 * lands in 'probe_failed', non-fatal: the redeploy and rotation already
 * succeeded and must still report success.
 *
 * When the caller passes a row whose remaining steps include
 * sending_onboarding (a Workers Free entitlement refusal at setup), sync
 * also RE-ATTEMPTS the onboarding POST — the completion path after a
 * plan upgrade — and reports it in cleared_steps; a repeated refusal or
 * any other failure keeps the step, non-fatally.
 */
export async function syncEmailDomain(
  input: EmailDomainSyncInput,
  deps: RelayEngineDeps = {},
): Promise<EmailDomainSyncResult> {
  const { account_id, relay_worker_name } = input.row;
  if (!account_id || !relay_worker_name) {
    return {
      status: 'failed',
      relay_version: null,
      setup_state: { failed_step: 'deploy_relay' },
      error: 'relay worker was never deployed — run the full setup first',
    };
  }
  const resolved = await resolveCredential(input.row.credential_kind, input.credential, deps);
  if (!resolved.ok) {
    return {
      status: resolved.status,
      relay_version: null,
      setup_state: { failed_step: 'verify_credential' },
      error: resolved.error,
    };
  }
  const newRelaySecret = (deps.generateRelaySecret ?? generateEmailRelaySecret)();
  try {
    await resolved.client.putRelayScript(account_id, relay_worker_name, {
      source: RELAY_SOURCE,
      compatibilityDate: RELAY_COMPATIBILITY_DATE,
      proxyOrigin: input.proxyOrigin,
      emailDomain: input.row.domain,
    });
    await resolved.client.putRelaySecret(account_id, relay_worker_name, newRelaySecret);
  } catch (err) {
    return {
      status: 'failed',
      relay_version: null,
      setup_state: { failed_step: 'deploy_relay' },
      ...(resolved.rotated_refresh_token === undefined
        ? {}
        : { rotated_refresh_token: resolved.rotated_refresh_token }),
      error: errorMessage(err),
    };
  }
  // Catch-all ensure (the header's drift doctrine). A probe or write
  // failure is non-fatal: the redeploy/rotation above already succeeded.
  let catchAll: EmailDomainSyncResult['catch_all'];
  if (input.row.zone_id) {
    try {
      const existing = await resolved.client.getCatchAll(input.row.zone_id);
      if (existing !== null && existing.enabled) {
        if (existing.workerName === relay_worker_name) {
          catchAll = 'already_set';
        } else if (existing.workerName !== null) {
          // An enabled rule naming another worker — never overwrite it.
          catchAll = 'foreign_conflict';
        }
      }
      if (catchAll === undefined) {
        // Absent, disabled, or enabled with a non-worker action.
        await resolved.client.setCatchAll(input.row.zone_id, relay_worker_name);
        catchAll = 'ensured';
      }
    } catch {
      catchAll = 'probe_failed';
    }
  }
  // Sending-onboarding retry — only when setup recorded the step (a
  // Workers Free entitlement refusal). A success, or a confirming
  // read-back behind a 400/409, clears the step; a repeated entitlement
  // refusal or any other error keeps it, non-fatally — the redeploy and
  // rotation already succeeded and outbound stays refused at CF.
  let clearedSteps: ReadonlyArray<string> | undefined;
  if (input.row.zone_id && input.row.setup_remaining_steps?.includes(SENDING_ONBOARDING_STEP)) {
    try {
      await resolved.client.onboardSending(input.row.zone_id, input.row.domain);
      clearedSteps = [SENDING_ONBOARDING_STEP];
    } catch (err) {
      if (
        err instanceof CloudflareApiError &&
        (err.status === 400 || err.status === 409) &&
        (await sendingOnboardedReadback(resolved.client, input.row.zone_id, input.row.domain))
      ) {
        clearedSteps = [SENDING_ONBOARDING_STEP];
      }
    }
  }
  return {
    status: 'active',
    relay_version: RELAY_VERSION,
    setup_state: null,
    ...(catchAll === undefined ? {} : { catch_all: catchAll }),
    ...(clearedSteps === undefined ? {} : { cleared_steps: clearedSteps }),
    new_relay_secret: newRelaySecret,
    ...(resolved.rotated_refresh_token === undefined
      ? {}
      : { rotated_refresh_token: resolved.rotated_refresh_token }),
  };
}

/**
 * `void email domain remove`: best-effort CF cleanup — DELETE the relay
 * script, then reset the zone catch-all (wrangler's drop-and-disable
 * shape). Never throws: a revoked credential strands the relay and the
 * rule in the customer's account, and neither may strand the row or the
 * mirror key, which the caller deletes unconditionally.
 *
 * The catch-all reset is CONDITIONAL and runs BEFORE the relay delete:
 * the rule is zone-scoped, so it is only reset when the ownership read
 * shows it still naming this row's relay — a rule pointing at another
 * worker (the customer repointed it, or a pre-fix second domain claimed
 * it) is left alone, and a row whose relay never deployed never wrote a
 * rule in the first place. If the ownership read or the reset fails, the
 * relay is NOT deleted either: an enabled catch-all must never be left
 * pointing at a deleted worker (the zone would bounce with no retry
 * handle once the caller deletes the row and mirror), so the rule and
 * its relay stay a consistent pair and both steps report failed.
 *
 * `repoint_catch_all_to` (conflict compensation): when the caller knows
 * the relay of the row that WON this zone, an owned catch-all is
 * REPOINTED at the winner instead of reset — the zone's inbound keeps
 * working rather than going dark. The winner's existence is checked
 * before AND after the PUT, so a winner deleted mid-compensation falls
 * back to the reset and the window is bounded to one CF round-trip. A
 * target that is absent, missing at CF, or names this row's own relay
 * takes the plain reset path, and any repoint-path failure reports
 * 'catch_all' and keeps the consistent pair, exactly like a reset
 * failure.
 *
 * `revokeGrant` dep (oauth_grant rows only): the grant is revoked as the
 * LAST step, after the CF cleanup attempts. The dep takes no token — it
 * revokes the row's LIVE chain head (callers pass the serialized helper):
 * a token captured earlier, the rotated one included, may already be
 * consumed by a lease refresh interleaved with the cleanup calls, and CF
 * answers 200 for a consumed token whether or not the grant survived. A
 * transient refresh failure revokes too (the stored token may still be
 * live and the row holding it is about to disappear); an invalid_grant
 * failure skips the revoke (CF already killed the grant). A revoke
 * rejection appends 'revoke_grant' to failed_steps and never throws.
 * api_token rows never revoke. The conflict-compensation caller
 * deliberately passes NO revokeGrant dep: it leaves its own row alive,
 * and revoking would brick the credential that row still owns.
 */
export async function removeEmailDomain(
  input: EmailDomainRemoveInput,
  deps: RelayEngineDeps = {},
): Promise<EmailDomainRemoveResult> {
  const failedSteps: Array<string> = [];
  let credential = input.credential;
  let grantRefreshed = false;
  if (input.row.credential_kind === 'oauth_grant') {
    try {
      const tokens = await (deps.refreshGrant ?? refreshOauthGrant)(input.credential);
      credential = tokens.accessToken;
      grantRefreshed = true;
    } catch (err) {
      failedSteps.push('delete_relay', 'catch_all');
      // invalid_grant means CF already killed the grant — nothing left to
      // revoke. Any other (transient) failure leaves the stored refresh
      // token possibly live: revoke it now, before the row holding it is
      // deleted.
      if (deps.revokeGrant && !(err instanceof OAuthGrantError && err.code === 'invalid_grant')) {
        try {
          await deps.revokeGrant();
        } catch {
          failedSteps.push('revoke_grant');
        }
      }
      return { failed_steps: failedSteps };
    }
  }
  const client = (deps.createClient ?? defaultCreateClient)(credential);
  // Detach first, delete second (the header's consistent-pair rule).
  let detachFailed = false;
  if (input.row.zone_id && input.row.relay_worker_name) {
    let catchAllIsOurs = false;
    try {
      const existing = await client.getCatchAll(input.row.zone_id);
      catchAllIsOurs =
        existing !== null &&
        existing.enabled &&
        existing.workerName === input.row.relay_worker_name;
    } catch {
      // Ownership unreadable — leave the rule untouched and report it.
      detachFailed = true;
    }
    if (catchAllIsOurs) {
      // Conflict compensation: with a winning relay named, REPOINT the
      // owned rule at the winner instead of resetting it. The winner's
      // existence is checked before AND after the PUT — a winner deleted
      // mid-compensation falls back to the reset, bounding the window to
      // one CF round-trip. Any failure here keeps the rule-and-relay
      // pair consistent, exactly like a reset failure.
      const repointTarget =
        input.repoint_catch_all_to !== undefined &&
        input.repoint_catch_all_to !== input.row.relay_worker_name
          ? input.repoint_catch_all_to
          : null;
      const repointAccountId = input.row.account_id;
      try {
        if (
          repointTarget !== null &&
          repointAccountId !== null &&
          (await client.relayScriptExists(repointAccountId, repointTarget))
        ) {
          await client.setCatchAll(input.row.zone_id, repointTarget);
          if (!(await client.relayScriptExists(repointAccountId, repointTarget))) {
            // The winner vanished under the PUT — fall back to the reset.
            await client.resetCatchAll(input.row.zone_id);
          }
        } else {
          await client.resetCatchAll(input.row.zone_id);
        }
      } catch {
        detachFailed = true;
      }
    }
    if (detachFailed) {
      failedSteps.push('catch_all');
    }
  }
  if (input.row.account_id && input.row.relay_worker_name) {
    if (detachFailed) {
      // Not attempted, deliberately: the enabled rule keeps its worker.
      failedSteps.push('delete_relay');
    } else {
      try {
        await client.deleteRelayScript(input.row.account_id, input.row.relay_worker_name);
      } catch {
        failedSteps.push('delete_relay');
      }
    }
  }
  // Grant revocation is the LAST step, after the CF cleanup attempts. The
  // dep revokes the row's live chain head — NOT the token this run
  // rotated: a lease refresh interleaved with the cleanup calls above
  // would already have consumed it, and revoking a consumed token answers
  // 200 while the newer grant lives on. A rejection is reported, never
  // thrown: the row removal proceeds regardless.
  if (grantRefreshed && deps.revokeGrant) {
    try {
      await deps.revokeGrant();
    } catch {
      failedSteps.push('revoke_grant');
    }
  }
  return { failed_steps: failedSteps };
}
