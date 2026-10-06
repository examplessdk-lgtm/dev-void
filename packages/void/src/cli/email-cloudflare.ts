import type { CloudflareOperation, CloudflareCommandResult } from '@void/deploy-cloudflare';
/**
 * Mode B email — the developer's OWN Cloudflare account (`void deploy --platform
 * cloudflare`). Design doc 0078, "Mode B — the developer's own Cloudflare account".
 *
 * Four pure-ish units, every Cloudflare touch injected so unit tests run on fakes:
 *
 *   deriveAddresses      email/ scan + domain  →  wrangler `addresses` (+ refusals)
 *   preflightEmail       read-only probes      →  one `EmailPreflight` state object
 *   renderEmailChecklist preflight             →  the block shown before the one Enter
 *   applyEmailSetup      preflight             →  only the rows not ready, in order,
 *                                                  returning the wrangler.jsonc patch
 *
 * Both callers (`void deploy --platform cloudflare` step 3b-ii and `void email
 * setup|status --platform cloudflare`) borrow the session bearer through the deploy
 * runner's `runWranglerAuthToken` and gate the prompt on `isWranglerNonInteractiveOrCI`
 * (both in `cli/deploy-cloudflare-auth.ts`), so the two never disagree.
 *
 * Rules that hold the whole thing together (0078 "The flow, by lane"):
 *
 *   - Void never refreshes, stores or forwards a token. Everything with a wrangler
 *     command goes through the injected runner (the deploy runner, pinned wrangler).
 *     The login session's bearer is borrowed via `getSessionBearer()` (backed by
 *     `wrangler auth token --json`) ONLY for the calls wrangler has no command for —
 *     subdomain routing enable, the subaddressing PATCH, and the `GET /zones?name=`
 *     zone classification — and it is dropped after each call. `fetchWithSessionBearer`
 *     is the ONLY function that ever receives the token; nothing here logs it, embeds
 *     it in a printed line, or places it in an error.
 *   - Rules and the catch-all are wrangler's job: Void derives `addresses`, writes the
 *     root config, and the existing `wrangler deploy` applies the plan. Void PRUNES an
 *     address already routed elsewhere so that plan is never destructive (decision 12).
 *   - `addresses` is written only when routing is ready for the domain, and deleted
 *     (never `[]`, which would delete every owned rule) otherwise (decision 11).
 *   - Void owns the whole top-level `addresses` array in Mode B; entries Void did not
 *     derive skip the email step for the deploy, array untouched (decision 13).
 *   - `ready` means no ACCOUNT work is left. Routing rules are `wrangler deploy`'s own
 *     (`rulesPending`), and the two CONFIG rows — `addresses` against the pruned set,
 *     `vars.__VOID_EMAIL_FROM` against `email.from` — are reconciled by a plain file write
 *     on every deploy, never behind the prompt (`addressesStale`, `sender`). A sending
 *     onboarding the committed `send_email` binding remembers as refused (Workers Free)
 *     is settled, not work: the binding is written only by a run that already attempted
 *     it. `void email setup` offers the retry (`sendingRetryable`); the deploy never does.
 *   - The session gate reads `whoami --json`: a `wrangler login` session must carry both
 *     email scopes; an API token (`CLOUDFLARE_API_TOKEN`, the CI credential) cannot list
 *     its permissions, so it is gated by the reads, which fail closed; a Global API Key is
 *     refused by name (no single bearer for the two REST-only calls).
 *
 * Email reads return structured Cloudflare data through the private command adapter.
 * Invalid data fails closed: the row reads `unknown` and the checklist directs the
 * developer to `void email setup`. Failed commands retain their API error codes.
 */
import { isRecord } from '@void/deploy-core';
import type { EmailHandlersScan } from '../router/email.ts';
import { findBindingNameOwner } from './wrangler.ts';

/** The `send_email` binding name Void provisions and the runtime reads. */
export const SEND_EMAIL_BINDING = 'SEND_EMAIL';

/** The root-config `vars` key carrying `void.config.ts` `email.from` into the worker. */
export const EMAIL_FROM_VAR = '__VOID_EMAIL_FROM';

/** Cloudflare's public API base — the same one `wrangler` targets by default. */
export const CLOUDFLARE_API_BASE_URL = 'https://api.cloudflare.com/client/v4';

/** The wrangler session scopes Mode B needs (`whoami --json` `tokenPermissions`). */
export const REQUIRED_EMAIL_SCOPES: ReadonlyArray<string> = [
  'email_routing:write',
  'email_sending:write',
];

/**
 * Cloudflare Email API error codes this module classifies (0078 "error map").
 * Everything else is reported verbatim.
 */
export const CF_EMAIL_ERROR_CODES: Readonly<Record<number, string>> = {
  2062: 'Email Routing is not enabled on this zone',
  2040: 'already onboarded for Email Sending',
  2036: 'account is not entitled to Email Sending',
  10105: 'account is not entitled to Email Sending',
};

/** The one-time dashboard step printed when the subdomain routing call cannot be made. */
export function subdomainDashboardFallback(apex: string, domain: string): string {
  return `Cloudflare dashboard → ${apex} → Email → Settings → Subdomains → add ${domain}, then redeploy`;
}

/** The Workers Free hint printed when Email Sending onboarding fails. */
export const SENDING_FREE_PLAN_HINT =
  'Workers Paid needed for arbitrary recipients. Inbound works; sendEmail() to verified destinations only.';

// ── Injected seams ─────────────────────────────────────────────────────────────

/** Provider results are structured at the subprocess boundary. */
export type EmailWranglerRunResult = CloudflareCommandResult;

export type EmailWranglerRun = (
  operation: CloudflareOperation,
  opts: { capture: boolean },
) => EmailWranglerRunResult | Promise<EmailWranglerRunResult>;

/** Public-DNS probes. Empty arrays mean "no record"; a throw means "could not read". */
export interface EmailDns {
  resolveMx(name: string): Promise<Array<{ exchange: string; priority: number }>>;
  resolveTxt(name: string): Promise<Array<Array<string>>>;
}

export type EmailFetch = typeof fetch;

/**
 * Everything `preflightEmail` / `applyEmailSetup` need. Every Cloudflare touch is a
 * seam; `getSessionBearer` resolves `null` when the session cannot be borrowed
 * (`wrangler auth token` failed) — never throws through to the deploy.
 */
export interface EmailCloudflareInputs {
  handlers: EmailHandlersScan;
  /** `void.config.ts` `email.from` — the ONLY domain input (decision 9). */
  from: string;
  /** The worker name `wrangler deploy` uploads as (rules are matched to it). */
  workerName: string;
  /** The reconciled effective account id the deploy is pinned to. */
  accountId: string;
  /** Existing root-config `send_email` array (verbatim), if any. */
  existingSendEmail?: Array<{ name?: unknown }> | null;
  /** Existing root-config top-level `addresses` array (verbatim), if any. */
  existingAddresses?: unknown;
  /** Existing root-config `vars` object (verbatim) — `__VOID_EMAIL_FROM` is compared to `from`. */
  existingVars?: Record<string, unknown> | null;
  /**
   * Root-config shapes the writer would refuse (`findEmailConfigConflicts`), computed by
   * the caller from the parsed root config; each becomes an `all` blocker so the refusal
   * lands BEFORE the Enter rather than after the account was changed.
   */
  configConflicts?: Array<string>;
  /** Number of source files calling `sendEmail()` — shown in the header line only. */
  sendEmailFiles?: number;
  /** The pinned project config used for provider operations. */
  configPath?: string;
  apiBaseUrl?: string;
  runWrangler: EmailWranglerRun;
  getSessionBearer: () => Promise<string | null>;
  fetchImpl: EmailFetch;
  dns: EmailDns;
}

/**
 * The root-config shapes `writeProvisionedWranglerConfig` refuses for the two names Mode
 * B writes — `SEND_EMAIL` into `send_email`, `__VOID_EMAIL_FROM` into `vars` — read from
 * the parsed root config BEFORE anything is asked, so a collision with another binding
 * type (or a malformed `send_email` / `vars`) refuses the step up front instead of after
 * the account was changed. Same guard as the writer's, which stays the last line of
 * defence (the file can change between preflight and write).
 */
export function findEmailConfigConflicts(config: Record<string, unknown>): Array<string> {
  // A Set: one malformed field is reported by both lookups (the owner scan reads every field).
  const conflicts = new Set<string>();
  const check = (field: string, name: string): void => {
    let owner: string | undefined;
    try {
      owner = findBindingNameOwner(config, field, name);
    } catch (err) {
      conflicts.add(`Cloudflare config: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (owner !== undefined) {
      conflicts.add(
        `Cloudflare config already uses ${name} as a ${owner} binding; rename it in void.config.ts (Void writes ${name} into ${field})`,
      );
    }
  };
  check('send_email', SEND_EMAIL_BINDING);
  check('vars', EMAIL_FROM_VAR);
  return [...conflicts];
}

// ── Derivation ─────────────────────────────────────────────────────────────────

export type EmailDomainMode = 'apex' | 'subdomain';

export interface DerivedEmailAddresses {
  /** Deduplicated, literal addresses first, `*@<apex>` last. */
  addresses: Array<string>;
  /** Handlers that get NO route in this mode, with the message shown to the developer. */
  refused: Array<{ handler: string; reason: string }>;
  /** `address → handler file` for the post-deploy map (catch-all listed as `*@…`). */
  routes: Array<{ address: string; handler: string }>;
}

/**
 * Host part of `email.from`, lowercased; `null` when it is not `local@host`. `void.config.ts`
 * also accepts the display-name form (`Acme <noreply@mail.acme.com>`, see `config.ts`),
 * so the address inside `<…>` is read when present.
 *
 * Validated per LABEL, not as one character class: the host is handed to wrangler as a
 * positional (`email routing settings <host>`), where a label starting with `-` is read
 * by yargs as a flag (`--config.evil` becomes an option and the domain positional goes
 * missing), and an empty label (`..acme.com`) is not a name at all.
 */
export function emailFromDomain(from: string): string | null {
  const bracketed = /<([^<>]*)>\s*$/.exec(from.trim());
  const address = bracketed ? (bracketed[1] as string) : from;
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) {
    return null;
  }
  const host = address
    .slice(at + 1)
    .trim()
    .toLowerCase();
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) {
    return null;
  }
  return host;
}

/**
 * `email/<literal>.ts` and `email/<literal>+[tag].ts` → `<literal>@<domain>`.
 * `email/_default.ts` and any dynamic local part (`[name].ts`, `[name]+[tag].ts`)
 * need a catch-all, which Cloudflare offers only on a zone apex: `*@<apex>` on the apex
 * path, refused with a message on a subdomain.
 *
 * Reuses the scanner's compiled pattern kinds rather than re-parsing filenames — the
 * grammar lives in `router/email.ts` and this must never disagree with the dispatcher.
 */
export function deriveAddresses(
  handlers: EmailHandlersScan,
  domain: string,
  mode: EmailDomainMode,
): DerivedEmailAddresses {
  const literals: Array<string> = [];
  const routes: Array<{ address: string; handler: string }> = [];
  const refused: Array<{ handler: string; reason: string }> = [];
  let needsCatchAll = false;
  const catchAllHandlers: Array<string> = [];

  for (const def of handlers.addresses) {
    const handler = `email/${def.filePath}`;
    if (def.pattern.kind === 'static' || def.pattern.kind === 'static-tag') {
      // `address` is the lowercased basename; the literal is everything before the `+`.
      const literal = def.address.split('+')[0] ?? def.address;
      const address = `${literal}@${domain}`;
      if (!literals.includes(address)) {
        literals.push(address);
      }
      routes.push({ address, handler });
      continue;
    }
    if (mode === 'subdomain') {
      refused.push({
        handler,
        reason: `a dynamic local part needs a catch-all, and a catch-all exists only on a zone apex; nothing at @${domain} reaches it`,
      });
      continue;
    }
    needsCatchAll = true;
    catchAllHandlers.push(handler);
  }

  if (handlers.defaultHandler) {
    const handler = `email/${handlers.defaultHandler}`;
    if (mode === 'subdomain') {
      refused.push({
        handler,
        reason: `a catch-all exists only on an apex; other @${domain} mail bounces`,
      });
    } else {
      needsCatchAll = true;
      catchAllHandlers.push(handler);
    }
  }

  const addresses = [...literals];
  if (needsCatchAll) {
    const catchAll = `*@${domain}`;
    addresses.push(catchAll);
    for (const handler of catchAllHandlers) {
      routes.push({ address: catchAll, handler });
    }
  }
  return { addresses, refused, routes };
}

// ── Structured command results ────────────────────────────────────────────────

/**
 * `wrangler whoami --json` — the fields Mode B reads. `tokenPermissions` is filled from
 * the STORED `wrangler login` state only (4.131 `getTokenPermissions` → `getScopes`), so
 * it describes the credential in use only when `authType` is `OAuth Token`; under
 * `CLOUDFLARE_API_TOKEN` it is absent (or, with a stale login file beside the env token,
 * it describes the file, not the token).
 */
export interface WhoamiJson {
  loggedIn: boolean;
  /** `OAuth Token` | `User API Token` | `Account API Token` | `Global API Key` (4.131 `getAuthType`). */
  authType?: string;
  email?: string;
  accounts?: Array<{ id: string; name: string }>;
  tokenPermissions?: Array<string>;
}

export function parseWhoamiJson(data: unknown): WhoamiJson | null {
  if (!isRecord(data) || typeof data.loggedIn !== 'boolean') {
    return null;
  }
  if (
    data.tokenPermissions !== undefined &&
    (!Array.isArray(data.tokenPermissions) ||
      data.tokenPermissions.some((scope) => typeof scope !== 'string'))
  ) {
    return null;
  }
  if (
    data.accounts !== undefined &&
    (!Array.isArray(data.accounts) ||
      data.accounts.some(
        (account) =>
          !isRecord(account) || typeof account.id !== 'string' || typeof account.name !== 'string',
      ))
  ) {
    return null;
  }
  return data as unknown as WhoamiJson;
}

export interface RoutingSettings {
  name: string;
  enabled: boolean;
  status: string;
  tag: string;
}

export interface RoutingRule {
  id: string;
  name: string;
  enabled: boolean;
  to: Array<string>;
  actions: Array<string>;
}

export interface RoutingRules {
  rules: Array<RoutingRule>;
  catchAll: { enabled: boolean; actions: Array<string> } | null;
}

export interface SendingSettings {
  name: string;
  enabled: boolean;
  tag: string;
}

export function readRoutingSettings(data: unknown): RoutingSettings | null {
  return isRecord(data) &&
    typeof data.name === 'string' &&
    data.name.length > 0 &&
    typeof data.enabled === 'boolean' &&
    typeof data.status === 'string' &&
    data.status.length > 0 &&
    typeof data.tag === 'string' &&
    /^[0-9a-f]{32}$/.test(data.tag)
    ? { name: data.name, enabled: data.enabled, status: data.status, tag: data.tag }
    : null;
}

export function readRoutingRules(data: unknown): RoutingRules | null {
  if (!Array.isArray(data)) {
    return null;
  }
  const rules: Array<RoutingRule> = [];
  let catchAll: RoutingRules['catchAll'] = null;
  for (const entry of data) {
    if (
      !isRecord(entry) ||
      typeof entry.enabled !== 'boolean' ||
      !Array.isArray(entry.actions) ||
      entry.actions.length === 0 ||
      !Array.isArray(entry.matchers) ||
      entry.matchers.length === 0
    ) {
      return null;
    }
    const actions: Array<string> = [];
    for (const action of entry.actions) {
      if (!isRecord(action) || typeof action.type !== 'string') {
        return null;
      }
      if (action.type === 'drop') {
        actions.push('drop');
      } else if (action.type === 'worker' || action.type === 'forward') {
        const values = typeof action.value === 'string' ? [action.value] : action.value;
        if (
          !Array.isArray(values) ||
          values.length === 0 ||
          !values.every((value) => typeof value === 'string' && value.length > 0)
        ) {
          return null;
        }
        if (action.type === 'worker') {
          actions.push('worker:' + values.join(','));
        } else {
          actions.push('forward:' + values.join(','));
        }
      } else {
        // Unknown actions cannot prove ownership or authorize taking over a rule.
        return null;
      }
    }
    const to: Array<string> = [];
    let all = false;
    for (const matcher of entry.matchers) {
      if (!isRecord(matcher)) {
        return null;
      }
      if (matcher.type === 'all') {
        all = true;
      } else if ((matcher.type === 'literal' && matcher.field === 'to') || matcher.type === 'to') {
        if (typeof matcher.value !== 'string' || matcher.value.length === 0) {
          return null;
        }
        to.push(matcher.value.toLowerCase());
      } else {
        return null;
      }
    }
    if (all) {
      if (catchAll || entry.matchers.length !== 1) {
        return null;
      }
      catchAll = { enabled: entry.enabled, actions };
    } else {
      if (
        typeof entry.id !== 'string' ||
        entry.id.length === 0 ||
        (entry.name !== undefined && typeof entry.name !== 'string')
      ) {
        return null;
      }
      rules.push({ id: entry.id, name: entry.name ?? '', enabled: entry.enabled, to, actions });
    }
  }
  return { rules, catchAll };
}

export function readSendingSettings(data: unknown): SendingSettings | null {
  if (!isRecord(data)) {
    return null;
  }
  const tag = data.tag ?? data.id;
  return typeof data.name === 'string' &&
    data.name.length > 0 &&
    typeof data.enabled === 'boolean' &&
    typeof tag === 'string' &&
    /^[0-9a-f]{32}$/.test(tag)
    ? { name: data.name, enabled: data.enabled, tag }
    : null;
}

function providerErrorCode(result: EmailWranglerRunResult): number | null {
  return result.errorCode ?? result.errors?.find((error) => error.code !== undefined)?.code ?? null;
}

function isHardFailure(result: EmailWranglerRunResult): boolean {
  return Boolean(result.signal) || Boolean(result.error);
}

// ── Preflight ──────────────────────────────────────────────────────────────────

export type ReadyState = 'ready' | 'pending' | 'unknown';

export interface EmailPreflightBlocker {
  /** `all` stops the whole email step; `sending` skips only Email Sending onboarding. */
  scope: 'all' | 'sending';
  message: string;
}

export interface EmailPreflight {
  from: string;
  domain: string;
  /** The zone the domain belongs to, once resolved (`domain` itself on the apex path). */
  apex: string | null;
  mode: EmailDomainMode | null;
  workerName: string;
  accountId: string;
  usage: { handlers: Array<string>; sendEmailFiles?: number };
  session: {
    state: 'ok' | 'not-logged-in' | 'missing-scopes' | 'api-key' | 'unknown';
    /** `whoami --json` `authType`; an API token's permissions are not enumerable. */
    authType?: string;
    email?: string;
    accountName?: string;
    missingScopes: Array<string>;
  };
  zone: {
    state: 'found' | 'not-found' | 'other-account' | 'partial' | 'unknown';
    zoneId?: string;
    /** `full` | `partial` | `secondary` from `GET /zones?name=`; unset without the bearer. */
    type?: string;
  };
  /** MX on the zone apex; `foreign` when a non-Cloudflare exchange answers. */
  apexMx: { state: 'empty' | 'cloudflare' | 'foreign' | 'unknown'; exchanges: Array<string> };
  /** MX on the mail domain itself (same as `apexMx` on the apex path). */
  domainMx: { state: 'empty' | 'cloudflare' | 'foreign' | 'unknown'; exchanges: Array<string> };
  routing: { state: ReadyState; status?: string; enabled?: boolean };
  /** Readable only through the bearer (`GET /zones/{z}/email/routing`); `unknown` without it. */
  subaddressing: { state: 'on' | 'off' | 'unknown' };
  sending: { state: ReadyState; dnsConflicts: Array<string> };
  rules: {
    state: ReadyState;
    mine: Array<string>;
    foreign: Array<{ address: string; owner: string }>;
    absent: Array<string>;
  };
  binding: { state: 'present' | 'absent' | 'foreign'; foreignName?: string };
  /** Root-config `vars.__VOID_EMAIL_FROM` against `from` — a config row, not an account row. */
  sender: { state: 'ready' | 'stale' | 'absent' };
  addressesOwnership: { state: 'absent' | 'mine' | 'foreign'; foreign: Array<string> };
  /**
   * True when the root `addresses` array (absent, or Void's own) is not the pruned set
   * below — a local, prompt-free rewrite, never account work, so it does not gate `ready`.
   * A stale entry left in place reaches wrangler's plan as a `conflict` (decision 12).
   */
  addressesStale: boolean;
  derived: DerivedEmailAddresses;
  /** `derived.addresses` minus the foreign-routed ones — what `addresses` will hold. */
  addresses: Array<string>;
  /** Derived addresses in `addresses` with no rule yet — `wrangler deploy` creates them. */
  rulesPending: Array<string>;
  blockers: Array<EmailPreflightBlocker>;
  /**
   * True when Email Sending onboarding is still on the table: the row is `pending` and no
   * sending-scoped blocker stands in the way — exactly when apply would make its one
   * `wrangler email sending enable` call (the checklist's `onboard … for Email Sending`
   * row). With the binding committed such a row is SETTLED (`ready` stays true; see the
   * memory rule in `preflightEmail`), so this is what `void email setup` offers as its own
   * prompt — the retry after a Workers Paid upgrade — instead of running it unasked. ONE
   * field, computed here, so the offer and apply's call cannot drift.
   */
  sendingRetryable: boolean;
  /**
   * True when nothing is left for APPLY to do on the account — no prompt, zero calls —
   * with one remembered exception: a sending row the committed binding records as refused
   * (`sendingRetryable`), which apply WOULD retry, so the deploy never runs apply on a
   * ready preflight and `void email setup` asks first. Routing rules are wrangler's
   * (`rulesPending` is informational), and the two config rows (`sender`,
   * `addressesStale`) are reconciled by a plain file write.
   */
  ready: boolean;
}

function mxState(exchanges: Array<string>): 'empty' | 'cloudflare' | 'foreign' {
  if (exchanges.length === 0) {
    return 'empty';
  }
  return exchanges.every((x) => /\.mx\.cloudflare\.net\.?$/i.test(x)) ? 'cloudflare' : 'foreign';
}

async function probeMx(
  dns: EmailDns,
  name: string,
): Promise<{ state: 'empty' | 'cloudflare' | 'foreign' | 'unknown'; exchanges: Array<string> }> {
  try {
    const records = await dns.resolveMx(name);
    const exchanges = records
      .slice()
      .sort((a, b) => a.priority - b.priority)
      .map((r) => r.exchange.toLowerCase());
    return { state: mxState(exchanges), exchanges };
  } catch (err) {
    if (isNoRecord(err)) {
      return { state: 'empty', exchanges: [] };
    }
    return { state: 'unknown', exchanges: [] };
  }
}

async function probeTxt(dns: EmailDns, name: string): Promise<'present' | 'absent' | 'unknown'> {
  try {
    const records = await dns.resolveTxt(name);
    return records.length > 0 ? 'present' : 'absent';
  } catch (err) {
    return isNoRecord(err) ? 'absent' : 'unknown';
  }
}

function isNoRecord(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ENODATA' || code === 'ENOTFOUND';
}

/** Candidate zone names for `mail.acme.com`: `mail.acme.com`, `acme.com`. */
function zoneCandidates(domain: string): Array<string> {
  const labels = domain.split('.');
  const out: Array<string> = [];
  for (let i = 0; i <= labels.length - 2; i += 1) {
    out.push(labels.slice(i).join('.'));
  }
  return out;
}

function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

/**
 * Read-only preflight. Order matters only for cost: public DNS first (free), then
 * `whoami` (no network beyond wrangler's own), then the three `wrangler email` reads,
 * then — if the bearer can be borrowed — the two GETs that have no wrangler command.
 * Nothing here writes.
 */
export async function preflightEmail(inputs: EmailCloudflareInputs): Promise<EmailPreflight> {
  const domain = emailFromDomain(inputs.from);
  if (!domain) {
    throw new Error(
      `email.from must be an address like you@mail.example.com (got ${JSON.stringify(inputs.from)})`,
    );
  }
  const apiBaseUrl = inputs.apiBaseUrl ?? CLOUDFLARE_API_BASE_URL;
  const run = async (operation: CloudflareOperation): Promise<EmailWranglerRunResult> =>
    inputs.runWrangler(
      { ...operation, ...(inputs.configPath ? { configPath: inputs.configPath } : {}) },
      { capture: true },
    );

  const usageHandlers = [
    ...inputs.handlers.addresses.map((d) => `email/${d.filePath}`),
    ...(inputs.handlers.defaultHandler ? [`email/${inputs.handlers.defaultHandler}`] : []),
  ];

  const pre: EmailPreflight = {
    from: inputs.from,
    domain,
    apex: null,
    mode: null,
    workerName: inputs.workerName,
    accountId: inputs.accountId,
    usage: { handlers: usageHandlers, sendEmailFiles: inputs.sendEmailFiles },
    session: { state: 'unknown', missingScopes: [] },
    zone: { state: 'unknown' },
    apexMx: { state: 'unknown', exchanges: [] },
    domainMx: { state: 'unknown', exchanges: [] },
    routing: { state: 'unknown' },
    subaddressing: { state: 'unknown' },
    sending: { state: 'unknown', dnsConflicts: [] },
    rules: { state: 'unknown', mine: [], foreign: [], absent: [] },
    binding: { state: 'absent' },
    sender: { state: 'absent' },
    addressesOwnership: { state: 'absent', foreign: [] },
    addressesStale: false,
    derived: { addresses: [], refused: [], routes: [] },
    addresses: [],
    rulesPending: [],
    blockers: [],
    sendingRetryable: false,
    ready: false,
  };
  const block = (scope: 'all' | 'sending', message: string): void => {
    pre.blockers.push({ scope, message });
  };
  // Every writer refusal the caller precomputed lands here, before anything is asked.
  for (const conflict of inputs.configConflicts ?? []) {
    block('all', conflict);
  }

  // 1. Session: logged in, and — for a browser (OAuth) session — both email scopes
  //    (0078: a session that predates wrangler 4.81 has neither; the pinned wrangler's
  //    default `login` scope set carries both, one browser Allow). An API token's
  //    permissions are not enumerable (`tokenPermissions` never describes it), so the gate
  //    is the reads below: a refused read fails closed as an `unknown` row. A Global API
  //    Key has no single bearer `auth token` can hand over, so the subaddressing rows could
  //    never read; it is refused up front, by name.
  //
  //    Every blocker names `void cloudflare login` (AGENTS.md: Cloudflare operations are
  //    described through Void, never as a wrangler command). That command is a no-op on a
  //    session `whoami --json` already reads cleanly — it re-uses the existing session
  //    rather than re-consenting — so a session that IS readable but insufficient (the
  //    scope and Global API Key branches) says what to clear first: `void cloudflare
  //    logout`, or the CLOUDFLARE_API_KEY pair, which wrangler prefers over both an OAuth
  //    session and CLOUDFLARE_API_TOKEN.
  const whoami = await run({ type: 'auth.whoami' });
  const who = isHardFailure(whoami) || whoami.status !== 0 ? null : parseWhoamiJson(whoami.data);
  if (!who) {
    // `whoami --json` failed or printed no session.
    pre.session.state = 'unknown';
    block('all', 'could not read the Cloudflare session — run `void cloudflare login`');
  } else if (!who.loggedIn) {
    pre.session.state = 'not-logged-in';
    block('all', 'not logged in to Cloudflare — run `void cloudflare login`');
  } else {
    pre.session.authType = who.authType;
    pre.session.email = who.email;
    pre.session.accountName = who.accounts?.find((a) => a.id === inputs.accountId)?.name;
    if (who.authType === 'Global API Key') {
      pre.session.state = 'api-key';
      block(
        'all',
        'the Cloudflare session is a Global API Key (CLOUDFLARE_API_KEY), which has no bearer to borrow for the subaddressing calls — unset CLOUDFLARE_API_KEY, then run `void cloudflare login` or set CLOUDFLARE_API_TOKEN to a token with Email Routing Edit + Email Sending Edit',
      );
    } else if (who.authType === undefined || who.authType === 'OAuth Token') {
      // A missing `authType` is an older payload shape: keep the scope gate (fail closed).
      const scopes = new Set(who.tokenPermissions ?? []);
      pre.session.missingScopes = REQUIRED_EMAIL_SCOPES.filter((s) => !scopes.has(s));
      if (pre.session.missingScopes.length > 0) {
        pre.session.state = 'missing-scopes';
        block(
          'all',
          `the Cloudflare session lacks ${pre.session.missingScopes.join(' + ')} — run \`void cloudflare logout\`, then \`void cloudflare login\` (one browser Allow)`,
        );
      } else {
        pre.session.state = 'ok';
      }
    } else {
      pre.session.state = 'ok';
    }
  }
  const tokenSession = pre.session.state === 'ok' && pre.session.authType !== 'OAuth Token';
  // Appended to a row an API-token session could not read: the likeliest cause is scope.
  const tokenHint = tokenSession
    ? ' (an API token needs Email Routing Edit + Email Sending Edit on the zone and account)'
    : '';

  // 2. Zone: walk the labels the way wrangler's own `resolveDomain` does, through
  //    `email routing settings <candidate>` — the first candidate that is a zone in the
  //    pinned account is the apex, and its data also carries routing status + zone id.
  let settings: RoutingSettings | null = null;
  let settingsMiss = false;
  if (pre.session.state === 'ok') {
    for (const candidate of zoneCandidates(domain)) {
      const result = await run({ type: 'email.routing.settings', domain: candidate });
      if (isHardFailure(result)) {
        settingsMiss = true;
        break;
      }
      if (result.status === 0 && result.data === null) {
        continue;
      }
      if (result.status !== 0) {
        settingsMiss = true;
        break;
      }
      settings = readRoutingSettings(result.data);
      if (!settings) {
        settingsMiss = true;
      }
      break;
    }
  }
  if (settings) {
    pre.apex = settings.name.toLowerCase();
    pre.mode = pre.apex === domain ? 'apex' : 'subdomain';
    pre.zone = { state: 'found', zoneId: settings.tag };
  } else if (settingsMiss) {
    block(
      'all',
      `could not read Email Routing settings — unknown — run \`void email setup --platform cloudflare\`${tokenHint}`,
    );
  } else if (pre.session.state === 'ok') {
    pre.zone.state = 'not-found';
  }

  // 3. Public DNS. Foreign MX on the mail domain is the one thing Void never routes over.
  pre.domainMx = await probeMx(inputs.dns, domain);
  pre.apexMx = pre.apex && pre.apex !== domain ? await probeMx(inputs.dns, pre.apex) : pre.domainMx;
  const dmarc = await probeTxt(inputs.dns, `_dmarc.${domain}`);
  const bounce = await probeTxt(inputs.dns, `cf-bounce.${domain}`);
  if (dmarc === 'present') {
    pre.sending.dnsConflicts.push(`_dmarc.${domain}`);
  }
  if (bounce === 'present') {
    pre.sending.dnsConflicts.push(`cf-bounce.${domain}`);
  }
  if (dmarc === 'unknown' || bounce === 'unknown') {
    pre.sending.dnsConflicts.push(`(DNS lookup failed for _dmarc.${domain} / cf-bounce.${domain})`);
  }

  // 4. The bearer, borrowed once for the two reads wrangler has no command for:
  //    `GET /zones?name=<apex>` (documented zone authority — WITHOUT `account.id`, so a
  //    zone in another account is told apart from one not on Cloudflare, and `type`
  //    refuses partial/secondary zones) and `GET /zones/{z}/email/routing`
  //    (`support_subaddress`, which the settings command does not return). A `null` bearer
  //    leaves both rows `unknown`; nothing about the deploy fails on that.
  let bearer: string | null = null;
  if (pre.session.state === 'ok') {
    bearer = await inputs.getSessionBearer().catch(() => null);
  }
  if (bearer) {
    const candidates = pre.apex ? [pre.apex] : zoneCandidates(domain);
    for (const candidate of candidates) {
      const zones = await fetchWithSessionBearer(
        inputs.fetchImpl,
        bearer,
        'GET',
        `/zones?name=${encodeURIComponent(candidate)}`,
        undefined,
        apiBaseUrl,
      );
      if (!zones.ok) {
        break;
      }
      const list = Array.isArray(zones.result) ? (zones.result as Array<ZoneRecord>) : [];
      const zone = list[0];
      if (!zone) {
        continue;
      }
      pre.zone.type = zone.type;
      if (zone.account?.id && zone.account.id !== inputs.accountId) {
        pre.zone = { state: 'other-account', zoneId: zone.id, type: zone.type };
      } else if (zone.type && zone.type !== 'full') {
        pre.zone = { state: 'partial', zoneId: zone.id, type: zone.type };
      } else {
        pre.zone = { state: 'found', zoneId: zone.id, type: zone.type };
        if (!pre.apex) {
          pre.apex = zone.name.toLowerCase();
          pre.mode = pre.apex === domain ? 'apex' : 'subdomain';
        }
      }
      break;
    }
    if (pre.zone.state === 'found' && pre.zone.zoneId) {
      const routing = await fetchWithSessionBearer(
        inputs.fetchImpl,
        bearer,
        'GET',
        `/zones/${pre.zone.zoneId}/email/routing`,
        undefined,
        apiBaseUrl,
      );
      const flag = (routing.result as { support_subaddress?: unknown } | null)?.support_subaddress;
      if (routing.ok && typeof flag === 'boolean') {
        pre.subaddressing.state = flag ? 'on' : 'off';
      }
    }
  }
  bearer = null;

  switch (pre.zone.state) {
    case 'not-found':
      block(
        'all',
        `no zone for ${domain} in Cloudflare account ${inputs.accountId} — add the domain to this account first`,
      );
      break;
    case 'other-account':
      block(
        'all',
        `${pre.apex ?? domain} is a zone in a different Cloudflare account than ${inputs.accountId}`,
      );
      break;
    case 'partial':
      block(
        'all',
        `${pre.apex ?? domain} is a ${pre.zone.type} zone; Email Routing needs a full zone on Cloudflare DNS`,
      );
      break;
    default:
      break;
  }

  if (!pre.apex || !pre.mode) {
    pre.ready = false;
    return pre;
  }
  const apex = pre.apex;
  const mode = pre.mode;

  // 5. Routing status. On the apex, `ready` is the only good state. `unlocked` /
  //    `misconfigured*` mean its locked records changed — print, never re-lock (0078).
  if (settings) {
    if (mode === 'apex') {
      pre.routing = {
        state: settings.enabled && settings.status === 'ready' ? 'ready' : 'pending',
        status: settings.status,
        enabled: settings.enabled,
      };
      if (/^(unlocked|misconfigured)/.test(settings.status)) {
        block(
          'all',
          `Email Routing on ${apex} is ${settings.status} — fix it in the Cloudflare dashboard; Void never re-locks records you unlocked`,
        );
      }
    } else {
      // No command reads a subdomain's routing state (`GET …/routing/dns?subdomain=` is
      // deprecated), so the subdomain's MX is the readiness signal: Cloudflare's own
      // exchanges mean enabled. A zone with routing configured only on subdomains reports
      // the apex as `misconfigured` because the apex has no routing MX; that says nothing
      // about this domain. Preserve only `unlocked` as an explicit signal that the developer
      // took control of Cloudflare-managed apex records.
      pre.routing = {
        state:
          pre.domainMx.state === 'cloudflare'
            ? 'ready'
            : pre.domainMx.state === 'unknown'
              ? 'unknown'
              : 'pending',
        status: settings.status,
        enabled: settings.enabled,
      };
      if (settings.status === 'unlocked') {
        block(
          'all',
          `Email Routing on ${apex} is ${settings.status} — fix it in the Cloudflare dashboard; Void never re-locks records you unlocked`,
        );
      }
    }
  }
  if (pre.routing.state !== 'ready') {
    if (pre.domainMx.state === 'foreign') {
      block(
        'all',
        `${domain} already receives mail (${pre.domainMx.exchanges.join(', ')}). Void never enables routing over live mail.${
          mode === 'apex' ? ` Use something@mail.${apex}.` : ''
        }`,
      );
    } else if (pre.domainMx.state === 'unknown') {
      block(
        'all',
        `could not read the MX records of ${domain} — unknown — run \`void email setup --platform cloudflare\``,
      );
    }
  }

  // 6. Derivation, then rules: mine / foreign / absent per derived address.
  pre.derived = deriveAddresses(inputs.handlers, domain, mode);
  const rulesResult = await run({ type: 'email.routing.rules.list', domain: apex });
  const rules =
    isHardFailure(rulesResult) || rulesResult.status !== 0
      ? null
      : readRoutingRules(rulesResult.data);
  if (!rules) {
    pre.rules.state = 'unknown';
    block(
      'all',
      `could not read Email Routing rules — unknown — run \`void email setup --platform cloudflare\`${tokenHint}`,
    );
  } else {
    const workerToken = `worker:${inputs.workerName}`;
    for (const address of pre.derived.addresses) {
      if (address.startsWith('*@')) {
        if (!rules.catchAll || !rules.catchAll.enabled || rules.catchAll.actions.includes('drop')) {
          pre.rules.absent.push(address);
        } else if (rules.catchAll.actions.includes(workerToken)) {
          pre.rules.mine.push(address);
        } else {
          pre.rules.foreign.push({ address, owner: rules.catchAll.actions.join(', ') });
        }
        continue;
      }
      // An enabled rule decides the row. A disabled one routes nothing: OUR disabled rule
      // reads `absent`, like the disabled catch-all above — the address stays in
      // `addresses`, and wrangler's plan (which writes every rule `enabled: true`) turns
      // it back on at the next deploy. A disabled FOREIGN rule stays `foreign`: the
      // matcher is still somebody else's, and taking it over is the same conflict the
      // enabled case prunes the address to avoid.
      const rule =
        rules.rules.find((r) => r.enabled && r.to.includes(address)) ??
        rules.rules.find((r) => r.to.includes(address));
      if (!rule) {
        pre.rules.absent.push(address);
      } else if (rule.actions.includes(workerToken)) {
        if (rule.enabled) {
          pre.rules.mine.push(address);
        } else {
          pre.rules.absent.push(address);
        }
      } else {
        pre.rules.foreign.push({ address, owner: rule.actions.join(', ') });
      }
    }
    pre.rules.state = pre.rules.absent.length === 0 ? 'ready' : 'pending';
  }
  const foreign = new Set(pre.rules.foreign.map((f) => f.address));
  pre.addresses = pre.derived.addresses.filter((a) => !foreign.has(a));

  // 7. Sending. Not-found is a clean "not onboarded"; anything else unparsable is unknown.
  const sendingResult = await run({ type: 'email.sending.settings', domain });
  if (isHardFailure(sendingResult)) {
    pre.sending.state = 'unknown';
  } else if (sendingResult.status === 0 && sendingResult.data === null) {
    pre.sending.state = 'pending';
  } else if (sendingResult.status === 0) {
    const parsed = readSendingSettings(sendingResult.data);
    pre.sending.state = parsed ? (parsed.enabled ? 'ready' : 'pending') : 'unknown';
  } else {
    pre.sending.state = 'unknown';
  }
  if (pre.sending.state === 'unknown') {
    block(
      'sending',
      `could not read Email Sending settings — unknown — run \`void email setup --platform cloudflare\`${tokenHint}`,
    );
  } else if (pre.sending.state === 'pending' && pre.sending.dnsConflicts.length > 0) {
    block(
      'sending',
      `${pre.sending.dnsConflicts.join(', ')} already exists; onboarding writes its own _dmarc (p=reject) and DKIM records and would conflict — remove them or keep sending off`,
    );
  }

  // 8. The config rows: `send_email` binding and `addresses` ownership (decision 13).
  const existingSendEmail = inputs.existingSendEmail ?? [];
  const names = existingSendEmail.map((e) => (typeof e?.name === 'string' ? e.name : ''));
  if (names.includes(SEND_EMAIL_BINDING)) {
    pre.binding = { state: 'present' };
  } else if (names.length > 0) {
    pre.binding = { state: 'foreign', foreignName: names[0] };
    block(
      'all',
      `Cloudflare config already has a send_email binding named ${JSON.stringify(names[0])}; rename it to ${SEND_EMAIL_BINDING} in void.config.ts (a second binding would be silent)`,
    );
  }
  if (inputs.existingAddresses !== undefined && inputs.existingAddresses !== null) {
    const existing = Array.isArray(inputs.existingAddresses)
      ? inputs.existingAddresses.map((a) => (typeof a === 'string' ? a.toLowerCase() : String(a)))
      : ['(not an array)'];
    // The candidate set is THIS scan's derivation. Void records no provenance for the
    // entries it wrote on an earlier deploy (the array carries no marker), so an entry
    // left behind by a deleted handler and a hand-written one are the same thing here:
    // both are `unknown`, and the whole step is skipped with the array untouched
    // (decision 13). With no handlers left at all the candidate set is empty and every
    // committed entry is `unknown` — the rule stays routed to this worker. Whether such
    // a leftover should instead be Void-managed (pruned, or `[]` when nothing is left) is
    // decision 13's other branch; see the deploy step's note above `patch.addresses`.
    const candidates = new Set(pre.derived.addresses);
    const unknown = existing.filter((a) => !candidates.has(a));
    if (unknown.length > 0) {
      pre.addressesOwnership = { state: 'foreign', foreign: unknown };
      block(
        'all',
        `Cloudflare addresses holds entries Void did not derive (${unknown.join(', ')}); remove ${unknown.map((a) => JSON.stringify(a)).join(', ')} from cloudflare.addresses in void.config.ts, or manage addresses by hand and unset email.from — skipping email setup this deploy`,
      );
    } else {
      pre.addressesOwnership = { state: 'mine', foreign: [] };
      // Void's own array, but not the pruned set: a foreign-routed entry left in place
      // (or a worker rename, which makes every rule foreign) reaches wrangler's plan as a
      // `conflict`, and `[]` would plan the deletion of every owned rule.
      const pruned = new Set(pre.addresses);
      pre.addressesStale =
        existing.length !== pre.addresses.length || existing.some((a) => !pruned.has(a));
    }
  } else {
    pre.addressesStale = pre.addresses.length > 0;
  }
  const senderVar = inputs.existingVars?.[EMAIL_FROM_VAR];
  pre.sender.state =
    senderVar === inputs.from ? 'ready' : senderVar === undefined ? 'absent' : 'stale';
  pre.rulesPending = pre.rules.absent.filter((a) => pre.addresses.includes(a));

  // Ready = nothing left for apply to do on the ACCOUNT. A refused handler and a pruned
  // address are `!` rows, not work; a sending-scoped blocker is something Void cannot act
  // on, so it does not keep every later deploy prompting. Routing rules are created by
  // `wrangler deploy` from the written `addresses`, so a rule not there yet is not apply's
  // work either (`rulesPending`); the same goes for the config rows, which a plain file
  // write reconciles without a prompt.
  //
  // A sending row still pending WITH the binding committed is settled too — the committed
  // binding is the memory of a refused onboarding. `sending settings` answers not-found
  // for "Workers Free" and for "Paid, never onboarded" alike, so no read tells the two
  // apart; only the mutating `sending enable` does. And `applyEmailSetup` writes
  // `send_email` ONLY on a run that has already made that call: the binding goes in once
  // routing or sending came up, and `enable` runs on every apply whose sending row is not
  // ready and not blocked. So binding present + sending pending reads "attempted and
  // refused" (Workers Free, `10105`). Without this rule the refusal came back on every
  // deploy — a prompt in a TTY, "cannot ask" in CI, `--require-email` refused forever,
  // `void email status` exit 1 — against a setup that is complete for inbound (replies
  // go through the native `message.reply()`, never the binding) and sends to verified
  // destinations. The cost: a later Workers Paid upgrade is not picked up by the deploy;
  // `void email setup` offers the retry (`sendingRetryable`). A binding committed by hand
  // reads the same way — the developer chose it. Note that with the binding present every
  // sending state is settled today (`unknown` always carries a sending-scoped blocker), so
  // the row gates `ready` only through the binding; the three terms stay apart because
  // each is settled for a different reason.
  const sendingBlocked = pre.blockers.some((b) => b.scope === 'sending');
  pre.sendingRetryable = pre.sending.state === 'pending' && !sendingBlocked;
  const sendingSettled =
    pre.sending.state === 'ready' ||
    sendingBlocked ||
    (pre.sending.state === 'pending' && pre.binding.state === 'present');
  pre.ready =
    !pre.blockers.some((b) => b.scope === 'all') &&
    pre.routing.state === 'ready' &&
    pre.subaddressing.state === 'on' &&
    sendingSettled &&
    pre.binding.state === 'present';
  return pre;
}

type ZoneRecord = { id: string; name: string; type?: string; account?: { id?: string } };

// ── Checklist ──────────────────────────────────────────────────────────────────

/** Column padding for the checklist; an overflowing cell gets three spaces (0078 transcript). */
function pad(text: string, width: number): string {
  return text.length >= width ? `${text}   ` : text.padEnd(width);
}

/**
 * The block shown before the one Enter — status rows, then the `+`/`!` change list
 * under the "This changes YOUR Cloudflare account" line (0078 transcript). Blockers
 * render as `✘` rows at the end so the developer sees why nothing will be asked.
 */
export function renderEmailChecklist(pre: EmailPreflight): string {
  const apex = pre.apex ?? '?';
  const lines: Array<string> = [];
  const inUse = [
    ...pre.usage.handlers,
    ...(pre.usage.sendEmailFiles
      ? [
          `sendEmail() in ${pre.usage.sendEmailFiles} file${pre.usage.sendEmailFiles === 1 ? '' : 's'}`,
        ]
      : []),
  ];
  lines.push(`  Email in use   ${inUse.join(' · ')}`);
  const row = (label: string, value: string, note = ''): void => {
    lines.push(`    ${pad(label, 10)}${note ? `${pad(value, 23)}${note}` : value}`);
  };
  row('domain', pre.domain, '(void.config.ts email.from)');
  const session = [
    pre.session.accountName
      ? `account ${pre.session.accountName} (${shortId(pre.accountId)})`
      : `account ${shortId(pre.accountId)}`,
    // An API token's permissions cannot be listed; a refused read shows up as its row.
    pre.session.authType && pre.session.authType !== 'OAuth Token'
      ? `session ${pre.session.email ? `${pre.session.email} ` : ''}(${pre.session.authType})`
      : pre.session.email
        ? `session ${pre.session.email}`
        : null,
  ]
    .filter(Boolean)
    .join(' · ');
  row('zone', pre.zone.state === 'found' ? apex : `${apex} ${pre.zone.state}`, session);
  if (pre.mode === 'subdomain') {
    row(
      'apex MX',
      pre.apexMx.exchanges[0] ?? (pre.apexMx.state === 'unknown' ? 'unknown' : 'none'),
      'left alone — mail lives on the subdomain',
    );
  } else {
    row(
      'apex MX',
      pre.apexMx.exchanges[0] ?? (pre.apexMx.state === 'unknown' ? 'unknown' : 'none'),
      pre.apexMx.state === 'cloudflare'
        ? 'Cloudflare Email Routing'
        : pre.apexMx.state === 'empty'
          ? 'empty — the apex can take routing'
          : '',
    );
  }
  const routingWord =
    pre.routing.state === 'ready'
      ? 'enabled'
      : pre.routing.state === 'unknown'
        ? 'unknown — run void email setup --platform cloudflare'
        : `not enabled${pre.mode === 'apex' && pre.routing.status && pre.routing.status !== 'unconfigured' ? ` (${pre.routing.status})` : ''}`;
  const subWord =
    pre.subaddressing.state === 'on'
      ? 'subaddressing on'
      : pre.subaddressing.state === 'off'
        ? 'subaddressing off'
        : 'subaddressing unknown';
  row('routing', `${pre.domain}  ${routingWord} · ${subWord}`);
  // A pending row the committed binding remembers as refused (see `preflightEmail`) reads
  // settled, so it says what still works and where the retry lives; a sending-scoped
  // blocker keeps the bare word — its ✘ row at the end carries the reason.
  const sendingWord =
    pre.sending.state === 'ready'
      ? 'onboarded'
      : pre.sending.state === 'unknown'
        ? 'unknown — run void email setup --platform cloudflare'
        : pre.sendingRetryable && pre.binding.state === 'present'
          ? 'not onboarded — verified destinations only; after upgrading to Workers Paid run void email setup --platform cloudflare'
          : 'not onboarded';
  row('sending', `${pre.domain}  ${sendingWord}`);
  if (pre.derived.addresses.length === 0) {
    row('rules', '(none — no email/ handlers)');
  }
  for (const address of pre.derived.addresses) {
    const foreignRule = pre.rules.foreign.find((f) => f.address === address);
    const status = pre.rules.mine.includes(address)
      ? 'ready'
      : foreignRule
        ? `owned elsewhere: ${foreignRule.owner} — pruned`
        : pre.rules.state === 'unknown'
          ? 'unknown'
          : 'absent';
    row('rules', `${address} → ${pre.workerName}`, `(${status})`);
  }
  row(
    'binding',
    SEND_EMAIL_BINDING,
    `(${pre.binding.state === 'present' ? 'present' : pre.binding.state === 'foreign' ? `found ${pre.binding.foreignName} instead` : 'absent'})`,
  );
  row('sender', pre.from, `(vars.${EMAIL_FROM_VAR} ${pre.sender.state})`);
  lines.push('');

  const changes: Array<string> = [];
  const change = (what: string, why: string): void => {
    changes.push(`    + ${pad(what, 44)}${why}`);
  };
  const warn = (what: string, why: string): void => {
    changes.push(`    ! ${pad(what, 44)}${why}`);
  };
  // A subdomain is added to a zone that already routes; when the apex does not, the apply
  // step makes no call (see `applyEmailSetup`) and the dashboard step is the row instead.
  const subdomainNeedsApex = pre.mode === 'subdomain' && pre.routing.enabled !== true;
  if (pre.routing.state !== 'ready' && subdomainNeedsApex) {
    warn(
      `enable Email Routing on ${pre.domain}`,
      `Email Routing is not enabled on ${apex}; Void never enables it on the apex from the subdomain path — ${subdomainDashboardFallback(apex, pre.domain)}`,
    );
  } else if (pre.routing.state !== 'ready') {
    change(
      `enable Email Routing on ${pre.domain}`,
      `Cloudflare writes and locks 3 MX + 1 SPF record ${pre.mode === 'subdomain' ? 'there' : 'on the apex'}`,
    );
  }
  if (pre.subaddressing.state !== 'on') {
    change(`turn on subaddressing for ${apex}`, 'support+anything@ reaches support@');
  }
  if (pre.sending.state !== 'ready' && !pre.blockers.some((b) => b.scope === 'sending')) {
    change(
      `onboard ${pre.domain} for Email Sending`,
      `MX/SPF/DKIM on cf-bounce.${pre.domain}, _dmarc.${pre.domain} (p=reject)`,
    );
  }
  // The config write, listed by the members that actually change (a config-only row —
  // `addresses` or the sender var — is rewritten without a prompt on the deploy path).
  const parts: Array<string> = [];
  if (pre.binding.state !== 'present') {
    parts.push(`send_email: [{ name: "${SEND_EMAIL_BINDING}" }]`);
  }
  if (pre.addressesStale) {
    parts.push(
      pre.addresses.length > 0
        ? `addresses: ${JSON.stringify(pre.addresses)}`
        : 'addresses: (removed)',
    );
  }
  if (pre.sender.state !== 'ready') {
    parts.push(`vars.${EMAIL_FROM_VAR}: ${JSON.stringify(pre.from)}`);
  }
  if (parts.length > 0) {
    change('Cloudflare config', parts.join(', '));
  }
  for (const address of pre.rules.absent) {
    change('routing rule (created on deploy)', `${address} → ${pre.workerName}`);
  }
  for (const foreign of pre.rules.foreign) {
    warn(foreign.address, `already routed to ${foreign.owner}; left alone, not in addresses`);
  }
  for (const refused of pre.derived.refused) {
    warn(refused.handler, refused.reason);
  }
  for (const blocker of pre.blockers) {
    changes.push(`    ✘ ${blocker.message}`);
  }
  if (changes.length === 0) {
    lines.push('  Nothing to change — email is set up.');
  } else {
    lines.push(
      `  This changes YOUR Cloudflare account.${pre.mode === 'subdomain' && !subdomainNeedsApex ? ` ${apex} itself is not touched.` : ''}`,
      ...changes,
    );
  }
  return lines.join('\n');
}

// ── Bearer bridge ──────────────────────────────────────────────────────────────

export interface SessionBearerResponse {
  ok: boolean;
  status: number;
  result: unknown;
  errors: Array<{ code: number; message: string }>;
}

/**
 * The ONLY function that receives the session bearer. It puts the token in the
 * `Authorization` header and nowhere else: not in the URL, not in a log line, not in
 * the returned object, not in an error. A transport failure is returned as
 * `{ ok: false, status: 0 }` with the underlying message (which names the URL at
 * most) — never thrown, so a caller can never leak the token through a stack trace.
 */
export async function fetchWithSessionBearer(
  fetchImpl: EmailFetch,
  bearer: string,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
  apiBaseUrl: string = CLOUDFLARE_API_BASE_URL,
): Promise<SessionBearerResponse> {
  const headers: Record<string, string> = { Authorization: `Bearer ${bearer}` };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  // Nothing this function returns may carry the token: a transport error message or an
  // API error message that echoed the header is scrubbed before it leaves this closure.
  const scrub = (text: string): string => text.split(bearer).join('[redacted]');
  let response: Response;
  try {
    response = await fetchImpl(`${apiBaseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      result: null,
      errors: [{ code: 0, message: scrub(err instanceof Error ? err.message : String(err)) }],
    };
  }
  let payload: {
    success?: boolean;
    result?: unknown;
    errors?: Array<{ code?: number; message?: string }>;
  } = {};
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    payload = {};
  }
  const errors = (payload.errors ?? []).map((e) => ({
    code: typeof e?.code === 'number' ? e.code : 0,
    message: typeof e?.message === 'string' ? scrub(e.message) : '',
  }));
  return {
    ok: response.ok && payload.success !== false,
    status: response.status,
    result: payload.result ?? null,
    errors,
  };
}

// ── Apply ──────────────────────────────────────────────────────────────────────

/**
 * The root-config patch Mode B writes. Shape-compatible with the `sendEmail` /
 * `addresses` / `vars` members of `ProvisionedWranglerPatch` (`cli/wrangler.ts`):
 * `addresses: null` deletes the key (never `[]`), `undefined` leaves it untouched.
 */
export interface EmailWranglerPatch {
  sendEmail?: { name: string };
  addresses?: Array<string> | null;
  vars?: Record<string, string>;
}

export interface EmailApplyResult {
  patch: EmailWranglerPatch;
  /** Human lines, in order — ✔ rows, hint lines, the dashboard fallback. */
  lines: Array<string>;
  routingReady: boolean;
  subaddressingReady: boolean;
  sendingReady: boolean;
  /** True when `addresses` was NOT written this run and the key is deleted instead. */
  addressesWithheld: boolean;
  /**
   * The inbound rows, together: routing ready AND subaddressing on AND `addresses`
   * written. Routing alone is not "set up" — a refused subaddressing PATCH withholds
   * `addresses` (no bearer call may fail, decision 11), so the next deploy creates no
   * rule at all, and until the flag is on `support+T-42@` matches no rule for `support@`.
   * `void email setup` exits 0 on this; `--require-email` gates on it plus the binding —
   * the sending row needs no term there, because the binding this same run writes is what
   * the next preflight reads as the memory of a refused onboarding (see `preflightEmail`).
   * ONE field, computed here, so the two callers cannot drift.
   */
  inboundReady: boolean;
}

/**
 * Run ONLY the rows preflight found not ready, in 0078 order:
 *
 *   routing   apex → `wrangler email routing enable <apex>`
 *             subdomain → bearer POST /zones/{z}/email/routing/dns { name }   [UNVERIFIED]
 *   subaddr   bearer PATCH /zones/{z}/email/routing { support_subaddress: true } [UNVERIFIED]
 *             (both paths — wrangler has no command for it)
 *   sending   `wrangler email sending enable <domain>`; `[code: 2040]` = already
 *             onboarded → ok; any other failure → hint line, continue without sending
 *
 * Any bearer failure (no bearer, or a non-2xx) prints the dashboard fallback line and
 * WITHHOLDS `addresses` this run — never a deploy failure (decision 11). A preflight
 * with an `all` blocker applies nothing and returns an empty patch.
 */
export async function applyEmailSetup(
  pre: EmailPreflight,
  inputs: EmailCloudflareInputs,
): Promise<EmailApplyResult> {
  const lines: Array<string> = [];
  const result: EmailApplyResult = {
    patch: {},
    lines,
    routingReady: pre.routing.state === 'ready',
    subaddressingReady: pre.subaddressing.state === 'on',
    sendingReady: pre.sending.state === 'ready',
    addressesWithheld: false,
    inboundReady: false,
  };
  const blocked = pre.blockers.filter((b) => b.scope === 'all');
  if (blocked.length > 0 || !pre.apex || !pre.mode) {
    for (const b of blocked) {
      lines.push(`  ✘ ${b.message}`);
    }
    if (blocked.length === 0) {
      lines.push(
        '  ✘ email: the zone could not be resolved — unknown — run `void email setup --platform cloudflare`',
      );
    }
    return result;
  }
  const apex = pre.apex;
  const apiBaseUrl = inputs.apiBaseUrl ?? CLOUDFLARE_API_BASE_URL;
  const run = async (operation: CloudflareOperation): Promise<EmailWranglerRunResult> =>
    inputs.runWrangler(
      { ...operation, ...(inputs.configPath ? { configPath: inputs.configPath } : {}) },
      { capture: true },
    );

  // The bearer is borrowed lazily, once, and dropped at the end of this function.
  let bearer: string | null | undefined;
  let bearerFailed = false;
  let bearerObtained = false;
  const borrow = async (): Promise<string | null> => {
    if (bearer === undefined) {
      bearer = await inputs.getSessionBearer().catch(() => null);
      if (bearer) {
        bearerObtained = true;
      } else {
        bearerFailed = true;
      }
    }
    return bearer;
  };
  const withBearer = async (
    method: 'POST' | 'PATCH',
    path: string,
    body: unknown,
  ): Promise<SessionBearerResponse | null> => {
    const token = await borrow();
    if (!token) {
      return null;
    }
    const response = await fetchWithSessionBearer(
      inputs.fetchImpl,
      token,
      method,
      path,
      body,
      apiBaseUrl,
    );
    if (!response.ok) {
      bearerFailed = true;
    }
    return response;
  };
  const describeFailure = (response: SessionBearerResponse | null): string => {
    if (!response) {
      // `auth token --json` failed, so no bearer could be borrowed.
      return 'could not borrow the Cloudflare session (session-bearer step failed)';
    }
    const first = response.errors[0];
    const code = first?.code ? ` [code: ${first.code}]` : '';
    const known = first?.code ? CF_EMAIL_ERROR_CODES[first.code] : undefined;
    return `Cloudflare answered ${response.status}${code}${known ? ` — ${known}` : first?.message ? ` — ${first.message}` : ''}`;
  };

  // 1. Routing.
  const apexRoutingOff = pre.mode === 'subdomain' && pre.routing.enabled !== true;
  if (!result.routingReady) {
    if (pre.mode === 'apex') {
      const enable = await run({ type: 'email.routing.enable', domain: apex });
      if (!isHardFailure(enable) && enable.status === 0) {
        result.routingReady = true;
        lines.push(`  ✔ routing   ${apex} enabled`);
      } else {
        const code = providerErrorCode(enable);
        lines.push(
          `  ✘ routing   could not enable Email Routing on ${apex}${code ? ` [code: ${code}]${CF_EMAIL_ERROR_CODES[code] ? ` — ${CF_EMAIL_ERROR_CODES[code]}` : ''}` : ''}`,
        );
      }
    } else if (apexRoutingOff) {
      // A subdomain is added to a zone that ALREADY routes (Cloudflare's Subdomains form
      // lives under an enabled apex). What the `name`-bearing POST does against a zone
      // whose routing is off is unmeasured, and the one outcome that would matter — the
      // zone itself being enabled, locking MX over the apex's live mail — is exactly what
      // the apex refusal exists to prevent. So no call is made; `addresses` is withheld.
      lines.push(
        `  ✘ routing   ${pre.domain}: Email Routing is not enabled on ${apex} — a subdomain can only be added to a zone that already routes; Void never enables routing on the apex from the subdomain path`,
      );
      lines.push(`    ${subdomainDashboardFallback(apex, pre.domain)}`);
    } else {
      // [UNVERIFIED] POST …/email/routing/dns { name } enables routing on a subdomain
      // (OpenAPI body field `name`; wrangler's own `routing enable` calls the deprecated
      // POST …/routing/enable which is apex-only). See 0078 "Still unverified" 1.
      const response = await withBearer('POST', `/zones/${pre.zone.zoneId}/email/routing/dns`, {
        name: pre.domain,
      });
      if (response?.ok) {
        result.routingReady = true;
        lines.push(`  ✔ routing   ${pre.domain} enabled`);
      } else {
        lines.push(`  ✘ routing   ${pre.domain}: ${describeFailure(response)}`);
        lines.push(`    ${subdomainDashboardFallback(apex, pre.domain)}`);
      }
    }
  }

  // 2. Subaddressing — per-zone, off by default, no wrangler command (0078 measured).
  //    [UNVERIFIED] PATCH with the OAuth session; see 0078 "Still unverified" 2.
  if (!result.subaddressingReady && !bearerFailed && !apexRoutingOff) {
    const response = await withBearer('PATCH', `/zones/${pre.zone.zoneId}/email/routing`, {
      support_subaddress: true,
    });
    if (response?.ok) {
      result.subaddressingReady = true;
      lines.push(`  ✔ routing   subaddressing on for ${apex}`);
    } else {
      lines.push(`  ✘ routing   subaddressing on ${apex}: ${describeFailure(response)}`);
      lines.push(
        `    turn it on in the Cloudflare dashboard → ${apex} → Email → Settings → Subaddressing`,
      );
    }
  } else if (!result.subaddressingReady) {
    // Skipped because an earlier bearer step failed: name the actual reason.
    lines.push(
      `  ✘ routing   subaddressing on ${apex}: skipped (${
        apexRoutingOff
          ? `Email Routing is not enabled on ${apex}`
          : bearerObtained
            ? 'the subdomain routing call failed'
            : 'session bearer unavailable'
      })`,
    );
  }
  bearer = null;

  // 3. Sending. 2040 = already onboarded. Anything else: hint, continue without it.
  const sendingBlocked = pre.blockers.filter((b) => b.scope === 'sending');
  if (!result.sendingReady && sendingBlocked.length > 0) {
    for (const b of sendingBlocked) {
      lines.push(`  ! sending   ${b.message}`);
    }
  } else if (!result.sendingReady) {
    const enable = await run({ type: 'email.sending.enable', domain: pre.domain });
    const code = isHardFailure(enable) ? null : providerErrorCode(enable);
    if (!isHardFailure(enable) && (enable.status === 0 || code === 2040)) {
      result.sendingReady = true;
      lines.push(`  ✔ sending   ${pre.domain} onboarded`);
    } else {
      const known = code ? CF_EMAIL_ERROR_CODES[code] : undefined;
      lines.push(
        `  ! sending   ${pre.domain} not onboarded${code ? ` [code: ${code}]` : ''}${known ? ` — ${known}` : ''}`,
      );
      lines.push(`    ${SENDING_FREE_PLAN_HINT}`);
    }
  }

  // 4. The patch. The binding is written only when routing is ready or sending is
  //    onboarded (a bare account never carries it). `addresses` is written only when
  //    routing is ready AND no bearer call failed this run; otherwise the key is deleted.
  if (result.routingReady || result.sendingReady) {
    result.patch.sendEmail = { name: SEND_EMAIL_BINDING };
    result.patch.vars = { [EMAIL_FROM_VAR]: pre.from };
  }
  result.addressesWithheld = bearerFailed || !result.routingReady;
  if (!result.addressesWithheld && pre.addresses.length > 0) {
    result.patch.addresses = pre.addresses;
  } else {
    result.patch.addresses = null;
    if (result.addressesWithheld && pre.addresses.length > 0) {
      lines.push(
        `  ! config    addresses withheld this run (${bearerFailed ? 'session-bearer step failed' : 'routing not ready'}); no routing rule is created for ${pre.addresses.join(', ')}`,
      );
    }
  }
  if (result.patch.sendEmail || result.patch.addresses !== undefined) {
    lines.push('  ✔ config    void.lock.json updated');
  }
  result.inboundReady =
    result.routingReady && result.subaddressingReady && !result.addressesWithheld;
  return result;
}

// ── Address map ────────────────────────────────────────────────────────────────

/**
 * The post-deploy block (0078 transcript):
 *
 *     inbound   support@mail.acme.com  →  email/support+[ticket].ts
 *     outbound  sendEmail() from support@mail.acme.com
 */
export function renderAddressMap(map: {
  from: string;
  routes: Array<{ address: string; handler: string }>;
  /** Addresses actually written to `addresses` — routes outside it are marked pending. */
  addresses: Array<string>;
  sendingReady: boolean;
  /** The pending marker; `void email status` passes one that does not name a deploy. */
  pendingLabel?: string;
  /** Written addresses whose rule does not exist yet — `wrangler deploy` creates it. */
  creating?: Array<string>;
}): string {
  const lines: Array<string> = [];
  const width = Math.max(0, ...map.routes.map((r) => r.address.length));
  const pending = map.pendingLabel ?? '(no rule this deploy)';
  for (const route of map.routes) {
    const live = map.addresses.includes(route.address);
    const marker = !live
      ? `   ${pending}`
      : map.creating?.includes(route.address)
        ? '   (rule created by this deploy)'
        : '';
    lines.push(`    inbound   ${pad(route.address, width + 2)}→  ${route.handler}${marker}`);
  }
  lines.push(
    `    outbound  sendEmail() from ${map.from}${map.sendingReady ? '' : '   (verified destinations only)'}`,
  );
  return lines.join('\n');
}

// ── Node DNS adapter ───────────────────────────────────────────────────────────

/** The production `EmailDns`: `node:dns/promises` against the system resolver. */
export async function createNodeEmailDns(): Promise<EmailDns> {
  const dns = await import('node:dns/promises');
  return {
    resolveMx: (name) => dns.resolveMx(name),
    resolveTxt: (name) => dns.resolveTxt(name),
  };
}
