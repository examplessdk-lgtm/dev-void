/**
 * Mode B email — the developer's OWN Cloudflare account (`void deploy --backend
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
 *
 * The prose parsers are PINNED to the wrangler version void ships (see
 * `WRANGLER_EMAIL_PROSE_VERSION` and `test/fixtures/wrangler-email/<version>/`).
 * A parser miss fails CLOSED: the row reads `unknown` and the checklist says to run
 * `void email setup`. Every `wrangler email` command prints an "open beta command"
 * warning on stderr, so the parsers read STDOUT only; stderr is consulted solely for
 * wrangler's `[code: N]` API error token on a FAILED command.
 */

import type { EmailHandlersScan } from '../router/email.ts';

/** The wrangler whose `email` prose the parsers below are pinned to. */
export const WRANGLER_EMAIL_PROSE_VERSION = '4.131.0';

/** The `send_email` binding name Void provisions and the runtime reads. */
export const SEND_EMAIL_BINDING = 'SEND_EMAIL';

/** The root-config `vars` key carrying `void.json` `email.from` into the worker. */
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

/** The one-time dashboard step printed when the session-bearer bridge fails. */
export const SUBDOMAIN_DASHBOARD_FALLBACK =
  'Cloudflare dashboard → your zone → Email → Settings → Subdomains → add the subdomain, then redeploy';

/** The Workers Free hint printed when Email Sending onboarding fails. */
export const SENDING_FREE_PLAN_HINT =
  'Workers Paid needed for arbitrary recipients. Inbound works; sendEmail() to verified destinations only.';

// ── Injected seams ─────────────────────────────────────────────────────────────

/** Mirrors the deploy runner's structured result (`DeployWranglerRunResult`). */
export type EmailWranglerRunResult = {
  status: number;
  stdout: string;
  stderr: string;
  /** Non-null ONLY when the child was killed by a signal — a HARD failure. */
  signal?: NodeJS.Signals | null;
  /** Spawn-error message when the child could not start — a HARD failure. */
  error?: string | null;
};

/**
 * Seam over void's pinned wrangler — structurally the deploy orchestrator's
 * `DeployWranglerRun`, declared here so this module never imports `deploy.ts`.
 */
export type EmailWranglerRun = (
  args: Array<string>,
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
  /** `void.json` `email.from` — the ONLY domain input (decision 9). */
  from: string;
  /** The worker name `wrangler deploy` uploads as (rules are matched to it). */
  workerName: string;
  /** The reconciled effective account id the deploy is pinned to. */
  accountId: string;
  /** Existing root-config `send_email` array (verbatim), if any. */
  existingSendEmail?: Array<{ name?: unknown }> | null;
  /** Existing root-config top-level `addresses` array (verbatim), if any. */
  existingAddresses?: unknown;
  /** Number of source files calling `sendEmail()` — shown in the header line only. */
  sendEmailFiles?: number;
  /** Extra argv appended to every wrangler call (the deploy passes `-c <cfg> --env=`). */
  wranglerArgs?: Array<string>;
  apiBaseUrl?: string;
  runWrangler: EmailWranglerRun;
  getSessionBearer: () => Promise<string | null>;
  fetchImpl: EmailFetch;
  dns: EmailDns;
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

/** Host part of `email.from`, lowercased; `null` when it is not `local@host`. */
export function emailFromDomain(from: string): string | null {
  const at = from.lastIndexOf('@');
  if (at <= 0 || at === from.length - 1) {
    return null;
  }
  const host = from
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return /^[a-z0-9.-]+\.[a-z0-9-]+$/.test(host) ? host : null;
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

// ── Prose parsers (pinned to WRANGLER_EMAIL_PROSE_VERSION) ─────────────────────

/** `wrangler whoami --json` — the fields Mode B reads. */
export interface WhoamiJson {
  loggedIn: boolean;
  email?: string;
  accounts?: Array<{ id: string; name: string }>;
  tokenPermissions?: Array<string>;
}

export function parseWhoamiJson(stdout: string): WhoamiJson | null {
  // The JSON is the whole of stdout for `--json`; tolerate a leading banner anyway.
  const start = stdout.indexOf('{');
  if (start < 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(stdout.slice(start)) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as WhoamiJson).loggedIn !== 'boolean'
    ) {
      return null;
    }
    return parsed as WhoamiJson;
  } catch {
    return null;
  }
}

/**
 * `wrangler email routing settings <zone>` stdout (4.131 `src/email-routing/settings.ts`):
 *
 *   Email Routing for void.cloud:
 *     Enabled:  true
 *     Status:   ready
 *     Created:  …
 *     Modified: …
 *     Tag:      5b66f5cb84fd7dcfdd0170515e622181
 *
 * `Tag` is the Email Routing settings tag, which is the ZONE ID in practice (measured:
 * void.app's tag equals its zone id). `GET /zones?name=` is the documented authority;
 * it is consulted only when the session bearer is already in hand (see `preflightEmail`).
 */
export interface RoutingSettingsProse {
  name: string;
  enabled: boolean;
  status: string;
  tag: string;
}

export function parseRoutingSettings(stdout: string): RoutingSettingsProse | null {
  const name = /^Email Routing for (\S+):\s*$/m.exec(stdout)?.[1];
  const enabled = /^\s*Enabled:\s+(true|false)\s*$/m.exec(stdout)?.[1];
  const status = /^\s*Status:\s+(\S+)\s*$/m.exec(stdout)?.[1];
  const tag = /^\s*Tag:\s+([0-9a-f]{32})\s*$/m.exec(stdout)?.[1];
  if (!name || !enabled || !status || !tag) {
    return null;
  }
  return { name, enabled: enabled === 'true', status, tag };
}

export interface RoutingRuleProse {
  id: string;
  name: string;
  enabled: boolean;
  /** `to:<address>` matchers, lowercased addresses. */
  to: Array<string>;
  /** `worker:<name>`, `forward:<a>,<b>`, `drop` — verbatim wrangler tokens. */
  actions: Array<string>;
}

export interface RoutingRulesProse {
  rules: Array<RoutingRuleProse>;
  catchAll: { enabled: boolean; actions: Array<string> } | null;
}

/**
 * `wrangler email routing rules list <zone>` stdout (4.131 `src/email-routing/rules/list.ts`):
 *
 *   Rule: <id>
 *     Name:     <name|(none)>
 *     Enabled:  true
 *     Matchers: to:support@void.cloud
 *     Actions:  worker:acme-support
 *     Priority: 0
 *
 *   Catch-all rule: disabled, action: drop
 *     (use `wrangler email routing rules get catch-all` to view details)
 *
 * With no rule at all: `No routing rules found.` / no custom rule: `No custom routing
 * rules found.`. Both forms are pinned by fixture.
 */
export function parseRoutingRules(stdout: string): RoutingRulesProse | null {
  const lines = stdout.split(/\r?\n/);
  const rules: Array<RoutingRuleProse> = [];
  let catchAll: RoutingRulesProse['catchAll'] = null;
  let sawSentinel = false;
  let current: RoutingRuleProse | null = null;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^No (custom )?routing rules found\.$/.test(line)) {
      sawSentinel = true;
      continue;
    }
    const catchAllMatch = /^Catch-all rule: (enabled|disabled), action: (.*)$/.exec(line);
    if (catchAllMatch) {
      catchAll = {
        enabled: catchAllMatch[1] === 'enabled',
        actions: splitActionList(catchAllMatch[2] ?? ''),
      };
      current = null;
      continue;
    }
    const ruleMatch = /^Rule: (\S+)$/.exec(line);
    if (ruleMatch) {
      current = { id: ruleMatch[1] as string, name: '', enabled: false, to: [], actions: [] };
      rules.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    const field = /^\s{2}(Name|Enabled|Matchers|Actions|Priority):\s*(.*)$/.exec(line);
    if (!field) {
      continue;
    }
    const value = (field[2] ?? '').trim();
    switch (field[1]) {
      case 'Name':
        current.name = value;
        break;
      case 'Enabled':
        current.enabled = value === 'true';
        break;
      case 'Matchers':
        current.to = value
          .split(', ')
          .filter((m) => m.startsWith('to:'))
          .map((m) => m.slice(3).toLowerCase());
        break;
      case 'Actions':
        current.actions = splitActionList(value);
        break;
      default:
        break;
    }
  }

  // Fail closed on prose we did not recognise: an output with neither a sentinel, a
  // rule, nor a catch-all line is not this wrangler's rules listing.
  if (!sawSentinel && rules.length === 0 && !catchAll) {
    return null;
  }
  return { rules, catchAll };
}

function splitActionList(value: string): Array<string> {
  return value
    .split(', ')
    .map((a) => a.trim())
    .filter(Boolean);
}

/**
 * `wrangler email sending settings <domain>` stdout (4.131 `src/email-routing/sending/settings.ts`):
 *
 *   Email Sending for void.cloud:
 *     Enabled:            true
 *     Tag:                19af4fdbee924a92916afea0de5a8fdd
 *     …
 *     Return-path domain: cf-bounce.void.cloud
 *
 * Not onboarded: exit 1 with `No sending subdomain found for \`<domain>\`.` on STDERR.
 */
export interface SendingSettingsProse {
  name: string;
  enabled: boolean;
  tag: string;
}

export function parseSendingSettings(stdout: string): SendingSettingsProse | null {
  const name = /^Email Sending for (\S+):\s*$/m.exec(stdout)?.[1];
  const enabled = /^\s*Enabled:\s+(true|false)\s*$/m.exec(stdout)?.[1];
  const tag = /^\s*Tag:\s+([0-9a-f]{32})\s*$/m.exec(stdout)?.[1];
  if (!name || !enabled || !tag) {
    return null;
  }
  return { name, enabled: enabled === 'true', tag };
}

/** wrangler renders an `APIError` note as `<message> [code: <n>]`; extract the code. */
export function wranglerApiErrorCode(text: string): number | null {
  const match = /\[code:\s*(\d+)\]/.exec(stripAnsi(text));
  return match ? Number(match[1]) : null;
}

const ANSI_SGR_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function stripAnsi(text: string): string {
  return text.replace(ANSI_SGR_RE, '');
}

const ZONE_NOT_FOUND_RE = /Could not find (?:a )?zone for `([^`]+)`/;
const SENDING_NOT_FOUND_RE = /No sending subdomain found for `([^`]+)`/;

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
    state: 'ok' | 'not-logged-in' | 'missing-scopes' | 'unknown';
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
  addressesOwnership: { state: 'absent' | 'mine' | 'foreign'; foreign: Array<string> };
  derived: DerivedEmailAddresses;
  /** `derived.addresses` minus the foreign-routed ones — what `addresses` will hold. */
  addresses: Array<string>;
  blockers: Array<EmailPreflightBlocker>;
  /** True when every row is ready: no prompt, no writes, zero calls on apply. */
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
  const extra = inputs.wranglerArgs ?? [];
  const run = async (args: Array<string>): Promise<EmailWranglerRunResult> =>
    inputs.runWrangler([...args, ...extra], { capture: true });

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
    addressesOwnership: { state: 'absent', foreign: [] },
    derived: { addresses: [], refused: [], routes: [] },
    addresses: [],
    blockers: [],
    ready: false,
  };
  const block = (scope: 'all' | 'sending', message: string): void => {
    pre.blockers.push({ scope, message });
  };

  // 1. Session: logged in, and the session carries both email scopes (0078: a session
  //    that predates wrangler 4.81 has neither → `wrangler login`, one browser Allow).
  const whoami = await run(['whoami', '--json']);
  const who = isHardFailure(whoami) || whoami.status !== 0 ? null : parseWhoamiJson(whoami.stdout);
  if (!who) {
    pre.session.state = 'unknown';
    block(
      'all',
      'could not read the wrangler session (`wrangler whoami --json` failed) — run `wrangler login`',
    );
  } else if (!who.loggedIn) {
    pre.session.state = 'not-logged-in';
    block('all', 'not logged in to Cloudflare — run `wrangler login`');
  } else {
    pre.session.email = who.email;
    pre.session.accountName = who.accounts?.find((a) => a.id === inputs.accountId)?.name;
    const scopes = new Set(who.tokenPermissions ?? []);
    pre.session.missingScopes = REQUIRED_EMAIL_SCOPES.filter((s) => !scopes.has(s));
    if (pre.session.missingScopes.length > 0) {
      pre.session.state = 'missing-scopes';
      block(
        'all',
        `the wrangler session lacks ${pre.session.missingScopes.join(' + ')} — run \`wrangler login\` again (one browser Allow)`,
      );
    } else {
      pre.session.state = 'ok';
    }
  }

  // 2. Zone: walk the labels the way wrangler's own `resolveDomain` does, through
  //    `email routing settings <candidate>` — the first candidate that is a zone in the
  //    pinned account is the apex, and its prose also carries routing status + zone id.
  let settings: RoutingSettingsProse | null = null;
  let settingsMiss = false;
  if (pre.session.state === 'ok') {
    for (const candidate of zoneCandidates(domain)) {
      const result = await run(['email', 'routing', 'settings', candidate]);
      if (isHardFailure(result)) {
        settingsMiss = true;
        break;
      }
      if (result.status !== 0) {
        if (ZONE_NOT_FOUND_RE.test(stripAnsi(result.stderr))) {
          continue;
        }
        settingsMiss = true;
        break;
      }
      settings = parseRoutingSettings(result.stdout);
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
    block('all', 'could not read Email Routing settings — unknown — run `void email setup`');
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
  //    (`support_subaddress`, which the settings prose does not print). A `null` bearer
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

  // 5. Routing status. `ready` is the only good state. `unlocked` / `misconfigured*`
  //    mean a developer changed the locked records — print, never re-lock (0078).
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
      // exchanges mean enabled. The apex prose still guards against an unlocked apex.
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
      if (/^(unlocked|misconfigured)/.test(settings.status)) {
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
        `could not read the MX records of ${domain} — unknown — run \`void email setup\``,
      );
    }
  }

  // 6. Derivation, then rules: mine / foreign / absent per derived address.
  pre.derived = deriveAddresses(inputs.handlers, domain, mode);
  const rulesResult = await run(['email', 'routing', 'rules', 'list', apex]);
  const rules =
    isHardFailure(rulesResult) || rulesResult.status !== 0
      ? null
      : parseRoutingRules(rulesResult.stdout);
  if (!rules) {
    pre.rules.state = 'unknown';
    block('all', 'could not read Email Routing rules — unknown — run `void email setup`');
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
      const rule = rules.rules.find((r) => r.to.includes(address));
      if (!rule) {
        pre.rules.absent.push(address);
      } else if (rule.actions.includes(workerToken)) {
        pre.rules.mine.push(address);
      } else {
        pre.rules.foreign.push({ address, owner: rule.actions.join(', ') });
      }
    }
    pre.rules.state = pre.rules.absent.length === 0 ? 'ready' : 'pending';
  }
  const foreign = new Set(pre.rules.foreign.map((f) => f.address));
  pre.addresses = pre.derived.addresses.filter((a) => !foreign.has(a));

  // 7. Sending. Not-found is a clean "not onboarded"; anything else unparsable is unknown.
  const sendingResult = await run(['email', 'sending', 'settings', domain]);
  if (isHardFailure(sendingResult)) {
    pre.sending.state = 'unknown';
  } else if (sendingResult.status === 0) {
    const parsed = parseSendingSettings(sendingResult.stdout);
    pre.sending.state = parsed ? (parsed.enabled ? 'ready' : 'pending') : 'unknown';
  } else if (SENDING_NOT_FOUND_RE.test(stripAnsi(sendingResult.stderr))) {
    pre.sending.state = 'pending';
  } else {
    pre.sending.state = 'unknown';
  }
  if (pre.sending.state === 'unknown') {
    block('sending', 'could not read Email Sending settings — unknown — run `void email setup`');
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
      `wrangler.jsonc already has a send_email binding named ${JSON.stringify(names[0])}; rename it to ${SEND_EMAIL_BINDING} (a second binding would be silent)`,
    );
  }
  if (inputs.existingAddresses !== undefined && inputs.existingAddresses !== null) {
    const existing = Array.isArray(inputs.existingAddresses)
      ? inputs.existingAddresses.map((a) => (typeof a === 'string' ? a.toLowerCase() : String(a)))
      : ['(not an array)'];
    const candidates = new Set(pre.derived.addresses);
    const unknown = existing.filter((a) => !candidates.has(a));
    if (unknown.length > 0) {
      pre.addressesOwnership = { state: 'foreign', foreign: unknown };
      block(
        'all',
        `wrangler.jsonc addresses holds entries Void did not derive (${unknown.join(', ')}); remove them or manage addresses by hand — skipping email setup this deploy`,
      );
    } else {
      pre.addressesOwnership = { state: 'mine', foreign: [] };
    }
  }

  // Ready = nothing left for apply to do. A refused handler and a pruned address are
  // `!` rows, not work; a sending-scoped blocker is something Void cannot act on, so it
  // does not keep every later deploy prompting. A sending onboarding that keeps failing
  // (Workers Free) DOES keep the row pending — there is no state to remember it by.
  const sendingSettled =
    pre.sending.state === 'ready' || pre.blockers.some((b) => b.scope === 'sending');
  pre.ready =
    !pre.blockers.some((b) => b.scope === 'all') &&
    pre.routing.state === 'ready' &&
    pre.subaddressing.state === 'on' &&
    sendingSettled &&
    pre.rules.state === 'ready' &&
    pre.binding.state === 'present' &&
    (pre.addresses.length === 0 || pre.addressesOwnership.state === 'mine');
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
  row('domain', pre.domain, '(void.json email.from)');
  const session = [
    pre.session.accountName
      ? `account ${pre.session.accountName} (${shortId(pre.accountId)})`
      : `account ${shortId(pre.accountId)}`,
    pre.session.email ? `session ${pre.session.email}` : null,
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
        ? 'unknown — run void email setup'
        : `not enabled${pre.mode === 'apex' && pre.routing.status && pre.routing.status !== 'unconfigured' ? ` (${pre.routing.status})` : ''}`;
  const subWord =
    pre.subaddressing.state === 'on'
      ? 'subaddressing on'
      : pre.subaddressing.state === 'off'
        ? 'subaddressing off'
        : 'subaddressing unknown';
  row('routing', `${pre.domain}  ${routingWord} · ${subWord}`);
  row(
    'sending',
    `${pre.domain}  ${pre.sending.state === 'ready' ? 'onboarded' : pre.sending.state === 'unknown' ? 'unknown — run void email setup' : 'not onboarded'}`,
  );
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
  lines.push('');

  const changes: Array<string> = [];
  const change = (what: string, why: string): void => {
    changes.push(`    + ${pad(what, 44)}${why}`);
  };
  const warn = (what: string, why: string): void => {
    changes.push(`    ! ${pad(what, 44)}${why}`);
  };
  if (pre.routing.state !== 'ready') {
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
  if (
    pre.binding.state !== 'present' ||
    pre.addressesOwnership.state !== 'mine' ||
    pre.rules.state !== 'ready'
  ) {
    const parts = [`send_email: [{ name: "${SEND_EMAIL_BINDING}" }]`];
    if (pre.addresses.length > 0) {
      parts.push(`addresses: ${JSON.stringify(pre.addresses)}`);
    }
    change('wrangler.jsonc', parts.join(', '));
  }
  for (const address of pre.rules.absent) {
    change('routing rule (applied by wrangler deploy)', `${address} → ${pre.workerName}`);
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
      `  This changes YOUR Cloudflare account.${pre.mode === 'subdomain' ? ` ${apex} itself is not touched.` : ''}`,
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
  };
  const blocked = pre.blockers.filter((b) => b.scope === 'all');
  if (blocked.length > 0 || !pre.apex || !pre.mode) {
    for (const b of blocked) {
      lines.push(`  ✘ ${b.message}`);
    }
    if (blocked.length === 0) {
      lines.push('  ✘ email: the zone could not be resolved — unknown — run `void email setup`');
    }
    return result;
  }
  const apex = pre.apex;
  const apiBaseUrl = inputs.apiBaseUrl ?? CLOUDFLARE_API_BASE_URL;
  const extra = inputs.wranglerArgs ?? [];
  const run = async (args: Array<string>): Promise<EmailWranglerRunResult> =>
    inputs.runWrangler([...args, ...extra], { capture: true });

  // The bearer is borrowed lazily, once, and dropped at the end of this function.
  let bearer: string | null | undefined;
  let bearerFailed = false;
  const borrow = async (): Promise<string | null> => {
    if (bearer === undefined) {
      bearer = await inputs.getSessionBearer().catch(() => null);
      if (!bearer) {
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
      return 'could not borrow the wrangler session (`wrangler auth token` failed)';
    }
    const first = response.errors[0];
    const code = first?.code ? ` [code: ${first.code}]` : '';
    const known = first?.code ? CF_EMAIL_ERROR_CODES[first.code] : undefined;
    return `Cloudflare answered ${response.status}${code}${known ? ` — ${known}` : first?.message ? ` — ${first.message}` : ''}`;
  };

  // 1. Routing.
  if (!result.routingReady) {
    if (pre.mode === 'apex') {
      const enable = await run(['email', 'routing', 'enable', apex]);
      if (!isHardFailure(enable) && enable.status === 0) {
        result.routingReady = true;
        lines.push(`  ✔ routing   ${apex} enabled`);
      } else {
        const code = wranglerApiErrorCode(enable.stderr);
        lines.push(
          `  ✘ routing   could not enable Email Routing on ${apex}${code ? ` [code: ${code}]${CF_EMAIL_ERROR_CODES[code] ? ` — ${CF_EMAIL_ERROR_CODES[code]}` : ''}` : ''}`,
        );
      }
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
        lines.push(`    ${SUBDOMAIN_DASHBOARD_FALLBACK}`);
      }
    }
  }

  // 2. Subaddressing — per-zone, off by default, no wrangler command (0078 measured).
  //    [UNVERIFIED] PATCH with the OAuth session; see 0078 "Still unverified" 2.
  if (!result.subaddressingReady && !bearerFailed) {
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
    lines.push(`  ✘ routing   subaddressing on ${apex}: skipped (session bearer unavailable)`);
  }
  bearer = null;

  // 3. Sending. 2040 = already onboarded. Anything else: hint, continue without it.
  const sendingBlocked = pre.blockers.filter((b) => b.scope === 'sending');
  if (!result.sendingReady && sendingBlocked.length > 0) {
    for (const b of sendingBlocked) {
      lines.push(`  ! sending   ${b.message}`);
    }
  } else if (!result.sendingReady) {
    const enable = await run(['email', 'sending', 'enable', pre.domain]);
    const code = isHardFailure(enable) ? null : wranglerApiErrorCode(enable.stderr);
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
    lines.push('  ✔ config    wrangler.jsonc updated');
  }
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
}): string {
  const lines: Array<string> = [];
  const width = Math.max(0, ...map.routes.map((r) => r.address.length));
  for (const route of map.routes) {
    const live = map.addresses.includes(route.address);
    lines.push(
      `    inbound   ${pad(route.address, width + 2)}→  ${route.handler}${live ? '' : '   (no rule this deploy)'}`,
    );
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
