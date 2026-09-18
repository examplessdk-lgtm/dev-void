import { execSync } from 'node:child_process';
import { confirm, isCancel, log, note, password } from '@clack/prompts';
import { parseRootWranglerConfig, readWranglerTopLevelString } from '@void/deploy-cloudflare';
import { readConfig } from '../config.ts';
import { readProjectPaths } from '../project-paths.ts';
import { scanEmailHandlersSync } from '../router/email.ts';
import { getToken, openBrowser } from './auth.ts';
import { revokeCfOauthGrant, runCfOauthGrant, type CfOauthGrant } from './cf-oauth.ts';
import {
  PlatformApiError,
  PlatformClient,
  type EmailDomainResponse,
  type EmailDomainStatusResponse,
} from './client.ts';
import {
  createDeployWranglerRunner,
  deriveWorkerName,
  discoverRootWranglerConfig,
  isWranglerNonInteractiveOrCI,
  loadProvisionModule,
  resolveDeployTransport,
  runWranglerAuthToken,
} from './deploy.ts';
import type { EmailArgs } from './email-args.ts';
import {
  applyEmailSetup,
  createNodeEmailDns,
  findEmailConfigConflicts,
  preflightEmail,
  renderAddressMap,
  renderEmailChecklist,
  type EmailCloudflareInputs,
  type EmailDns,
  type EmailFetch,
  type EmailPreflight,
  type EmailWranglerRun,
} from './email-cloudflare.ts';
import { createSpinner, pc } from './output.ts';
import { readProjectConfig } from './project.ts';
import { writeProvisionedWranglerConfig } from './wrangler.ts';

export async function runEmailCommand(root: string, args: EmailArgs): Promise<void> {
  // Mode B (design doc 0078) never touches the Void platform: no token, no project.
  if (args.platform === 'cloudflare') {
    return runEmailCloudflareCommand(root, args);
  }
  if (args.subcommand === 'setup') {
    log.error(
      'email: `void email setup` sets email up on your OWN Cloudflare account — run it with `--platform cloudflare`. The Void platform needs no setup: deploy, and `void email usage` shows your address.',
    );
    process.exit(1);
  }
  if (args.subcommand === 'status') {
    log.error(
      'email: `void email status` is available with `--platform cloudflare` today. On the Void platform use `void email usage` and `void email destinations`.',
    );
    process.exit(1);
  }

  const token = getToken(root);
  if (!token) {
    log.error('Not logged in. Run `void auth login` first.');
    process.exit(1);
  }

  const client = new PlatformClient(token, { root });

  // Resolve project
  const requestedSlug = args.projectSlug ?? process.env.VOID_PROJECT?.trim();
  let projectId: string | undefined;

  if (requestedSlug) {
    const projects = await client.listProjects();
    const project = projects.find((p) => p.slug === requestedSlug);
    if (!project) {
      log.error(`project: No project found with slug '${requestedSlug}'.`);
      process.exit(1);
    }
    projectId = project.id;
  } else {
    const config = readProjectConfig(root);
    if (!config) {
      log.error('No linked project. Run `void project link` or pass --project <name>.');
      process.exit(1);
    }
    projectId = config.projectId;
  }

  switch (args.subcommand) {
    case 'usage':
      return emailUsage(client, projectId!);
    case 'logs':
      return emailLogs(client, projectId!, args.limit);
    case 'destinations':
      return emailDestinations(client, projectId!);
    case 'allow':
      return emailAllow(client, projectId!, args.address!);
    case 'disallow':
      return emailDisallow(client, projectId!, args.address!);
    case 'domain':
      return runEmailDomainCommand(client, projectId!, args);
  }
}

async function emailUsage(client: PlatformClient, projectId: string): Promise<void> {
  const usage = await client.getEmailUsage(projectId);
  const status = usage.suspended ? pc.red('SUSPENDED') : pc.green('active');
  const lines = [
    `Month:       ${usage.month}`,
    `Status:      ${status}`,
    `Outbound:    ${usage.sent} / ${usage.limit} (${usage.remaining} remaining)`,
    `Inbound:     ${usage.received}`,
  ];
  note(lines.join('\n'), 'Email Usage');
}

async function emailDestinations(client: PlatformClient, projectId: string): Promise<void> {
  const rows = await client.listEmailDestinations(projectId);
  if (rows.length === 0) {
    log.info(
      'No verified destinations. Run `void email allow <address>` to add one — Cloudflare will email the recipient with a verification link.',
    );
    return;
  }
  const lines = rows.map((d) => {
    const status =
      d.status === 'verified'
        ? pc.green('verified')
        : d.status === 'pending'
          ? pc.yellow('pending')
          : pc.red('failed');
    return `  ${d.address.padEnd(40)} ${status}`;
  });
  note(lines.join('\n'), 'Email Destinations');
}

/**
 * `void email allow <address>` — exported for the unit test; the command
 * entry (`runEmailCommand`) resolves the client and project first.
 */
export async function emailAllow(
  client: Pick<PlatformClient, 'addEmailDestination'>,
  projectId: string,
  address: string,
): Promise<void> {
  const dest = await client.addEmailDestination(projectId, address);
  // Cloudflare mails its link on create only; the platform re-sends its own
  // on every repeat add (`platformVerificationPending`). A 201 alone does not
  // prove a send: the api adopts an address Cloudflare already held.
  const sent =
    dest.verificationSent !== false && (dest.created || dest.platformVerificationPending);
  if (dest.status === 'verified') {
    log.success(`${dest.address} is already verified.`);
  } else if (sent) {
    log.success(`Verification email sent to ${dest.address}.`);
    log.info(
      'They click the link in their inbox — no Void or Cloudflare account needed. `void email destinations` to poll status.',
    );
  } else if (dest.created) {
    log.warn(
      `${dest.address} is on this project's list now, but Cloudflare already had the address pending (added by another project, or by hand), so no new verification email was sent — the link it mailed when the address was first added is the one to click. ${freshLinkHint(dest.address)}`,
    );
  } else {
    log.info(
      `${dest.address} is still pending — Cloudflare emailed them a verification link when the address was first added, and a repeat add sends nothing new. ${freshLinkHint(dest.address)}`,
    );
  }
}

/**
 * Cloudflare has no API to resend its verification mail; the only fresh link
 * is a fresh registration, and the platform deletes the Cloudflare-side
 * address only once no project still lists it.
 */
function freshLinkHint(address: string): string {
  return `For a fresh link, remove the address from every project that lists it (\`void email disallow ${address}\`), then \`void email allow ${address}\` — Cloudflare mails a new link only when it registers the address anew.`;
}

/**
 * `void email disallow <address>` — exported for the unit test; the command
 * entry (`runEmailCommand`) resolves the client and project first.
 *
 * No deploy is involved: the api tightens the proxy's `email-allowlist`
 * KV mirror inside the DELETE (and answers 503 if that write fails), and
 * the proxy re-reads the mirror with a 60s `cacheTtl` on both the send
 * path and inbound forward/reply — so the address is refused once that
 * per-colo cache turns over.
 */
export async function emailDisallow(
  client: Pick<PlatformClient, 'listEmailDestinations' | 'removeEmailDestination'>,
  projectId: string,
  address: string,
): Promise<void> {
  const rows = await client.listEmailDestinations(projectId);
  const dest = rows.find((d) => d.address.toLowerCase() === address.toLowerCase());
  if (!dest) {
    log.error(`destination: '${address}' is not in the project's allowlist.`);
    process.exit(1);
  }
  await client.removeEmailDestination(projectId, dest.id);
  log.success(`Removed ${dest.address}. Sends to it are refused within about a minute.`);
}

/**
 * `void email logs` — exported for the unit test; the command entry
 * (`runEmailCommand`) resolves the client and project first.
 */
export async function emailLogs(
  client: Pick<PlatformClient, 'getEmailLogs'>,
  projectId: string,
  limit?: number,
): Promise<void> {
  // The API currently ignores `limit`; server-side wiring is pending the
  // Analytics Engine integration. Forwarding it now keeps the CLI
  // forward-compatible — once persistent storage lands, no client change is
  // needed.
  const result = await client.getEmailLogs(projectId, limit);
  if (result.pending) {
    log.info(result.note ?? 'Persistent log storage is not yet wired up.');
    // The proxy's own send/receive records are the platform worker's console
    // output, which a project's credentials cannot read — so nothing points
    // at them. The one thing a user CAN read today is their own worker's
    // console output: the email handler is invoked over RPC on the same
    // tailed script as every HTTP request, so it lands in `void project logs`.
    log.info(
      'Email activity logs are not available yet. Console output from your email handler appears in `void project logs`.',
    );
    return;
  }
  if (result.logs.length === 0) {
    log.info('No email activity recorded.');
    return;
  }
  const lines = result.logs.map((entry) => {
    const ts = new Date(entry.timestamp).toISOString();
    const dir = entry.direction === 'sent' ? '→' : '←';
    const subject = entry.subject ? ` "${entry.subject}"` : '';
    return `${ts}  ${dir}  ${entry.from} → ${entry.to}  ${entry.status}${subject}`;
  });
  note(lines.join('\n'), 'Email Logs');
}

// ── Custom domains on the customer's own Cloudflare zone (0078) ──────────────
//
// `void email domain add|status|list|sync|remove`. The api owns the
// orchestration (contract 7); the CLI owns the MX-decision render, the
// credential grant (the OAuth flow in cf-oauth.ts, the template link +
// clipboard watch below as the permanent fallback), and the result render.
// The credential — grant refresh token or pasted API token — is held in
// memory, POSTed once, and never printed, logged, or persisted locally.

/**
 * The dashboard template link's permission groups (contract 8). Every key
 * rides every link — there is no apex-only key, because `Zone Settings Edit`
 * gates the routing POST on both paths; `zone: read` is what the zone lookup
 * needs. URL-encoded by `URL.searchParams`.
 */
const CF_TOKEN_TEMPLATE_PERMISSION_GROUPS = [
  { key: 'zone', type: 'read' },
  { key: 'email_routing_rule', type: 'edit' },
  { key: 'email_sending', type: 'edit' },
  { key: 'workers_scripts', type: 'edit' },
  { key: 'zone_settings', type: 'edit' },
] as const;

/** The three-click template link — the fallback grant path (0078, "Creating the token in three clicks"). */
export function buildCfApiTokenTemplateUrl(domain: string): string {
  const url = new URL('https://dash.cloudflare.com/profile/api-tokens');
  url.searchParams.set('permissionGroupKeys', JSON.stringify(CF_TOKEN_TEMPLATE_PERMISSION_GROUPS));
  // Both are required by the form; the customer narrows them in the summary.
  url.searchParams.set('accountId', '*');
  url.searchParams.set('zoneId', 'all');
  url.searchParams.set('name', `Void email — ${domain}`);
  return url.href;
}

/** 'refused' and 'unknown' are both rejected; 'refused' names a known foreign prefix in the error. */
export type CfApiTokenShape = 'cfut' | 'legacy' | 'refused' | 'unknown';

// The current format (Cloudflare's token-formats doc, 2026): the `cfut_`
// prefix, 40 characters, then a CRC32 checksum. The doc pins the 40 but not
// the checksum's exact rendered length, so the tail is bounded loosely —
// `GET /user/tokens/verify` is the real gate, not this regex.
const CFUT_TOKEN_PATTERN = /^cfut_[A-Za-z0-9_-]{44,64}$/;
// Pre-2026 tokens: an unprefixed 40-character string. Still accepted by CF.
const LEGACY_CF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{40}$/;
// Other dashboards' tokens are refused WITHOUT a network call (0078) —
// pasting the wrong site's token is the common mistake, and naming it beats
// a CF 401. `cfk_` is Cloudflare's own global key, also not a scoped token.
const REFUSED_TOKEN_PREFIXES = ['ghp_', 'github_pat_', 'sk-', 'xox', 'cfk_'] as const;

/** Shape-only classification of a clipboard or pasted value. Never logs the value. */
export function classifyCfApiTokenShape(value: string): CfApiTokenShape {
  const token = value.trim();
  // Refused FIRST: `ghp_` + 36 chars is exactly the legacy 40-char shape, and
  // 0078's rule is that another dashboard's token is refused without a
  // network call — the refusal wins over the legacy-shape coincidence.
  if (REFUSED_TOKEN_PREFIXES.some((prefix) => token.startsWith(prefix))) {
    return 'refused';
  }
  if (CFUT_TOKEN_PATTERN.test(token)) {
    return 'cfut';
  }
  if (LEGACY_CF_TOKEN_PATTERN.test(token)) {
    return 'legacy';
  }
  return 'unknown';
}

// Clipboard helpers — the read side mirrors the write side in auth-cmd.ts
// (pbcopy / clip / xclip); wl-paste/wl-copy cover Wayland sessions.
function readClipboard(): string | null {
  const platform = process.platform;
  const command =
    platform === 'darwin'
      ? 'pbpaste'
      : platform === 'win32'
        ? 'powershell -NoProfile -Command Get-Clipboard'
        : 'xclip -o -selection clipboard';
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    if (platform !== 'darwin' && platform !== 'win32') {
      try {
        return execSync('wl-paste', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        // No clipboard tool (SSH, CI, a bare Wayland session) — the paste prompt is the path.
      }
    }
    return null;
  }
}

/** `pbcopy </dev/null` and the platform equivalents — best-effort, never throws. */
function clearClipboard(): void {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      execSync('pbcopy', { input: '' });
    } else if (platform === 'win32') {
      execSync('clip', { input: '' });
    } else {
      try {
        execSync('xclip -selection clipboard', { input: '' });
      } catch {
        execSync('wl-copy', { input: '' });
      }
    }
  } catch {
    // Best-effort: a headless session has nothing to clear, and a failure
    // here must not fail the add (the doc says so once, below).
  }
}

export type CfTokenVerification = 'active' | 'inactive' | 'unknown';

/**
 * The CLI-side active check from 0078's clipboard sequence. 'unknown' means
 * the check could not run (no network, a CF error) — the caller proceeds and
 * lets the platform verify authoritatively, never treating a network blip as
 * a bad token. The token itself is never logged.
 */
async function verifyCfApiToken(token: string): Promise<CfTokenVerification> {
  let res: Response;
  try {
    res = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    return 'unknown';
  }
  if (res.status === 401 || res.status === 403) {
    return 'inactive';
  }
  if (!res.ok) {
    return 'unknown';
  }
  try {
    const body = (await res.json()) as { result?: { status?: unknown } };
    return body.result?.status === 'active' ? 'active' : 'inactive';
  } catch {
    return 'unknown';
  }
}

/** Mirror of the api's normalization (`normalizeEmailDomain`). */
export function normalizeEmailDomainInput(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Same DNS-hostname shape the api enforces — checked here so junk fails
 * before a grant is ever requested, not after. Real validation stays the
 * platform's zone lookup.
 */
export function isValidEmailDomainInput(domain: string): boolean {
  return /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(domain);
}

/**
 * Where `--subdomain` lands: a bare label nests under the positional domain
 * (`mx` → `mx.acme.com`), a full host is taken as-is but must stay under it.
 * Throws on anything else — the user named a domain this add cannot register.
 */
export function resolveEmailDomainTarget(
  domain: string,
  subdomain?: string,
): { emailDomain: string; forced: boolean } {
  if (subdomain === undefined) {
    return { emailDomain: domain, forced: false };
  }
  const candidate = subdomain.trim().toLowerCase().replace(/\.$/, '');
  const resolved = candidate.includes('.') ? candidate : `${candidate}.${domain}`;
  if (!isValidEmailDomainInput(resolved)) {
    throw new Error(`email: invalid --subdomain value '${subdomain}'.`);
  }
  if (resolved === domain || !resolved.endsWith(`.${domain}`)) {
    throw new Error(`email: --subdomain must name a subdomain of ${domain} (got '${subdomain}').`);
  }
  return { emailDomain: resolved, forced: true };
}

/**
 * Local public-DNS MX read. [] = no records, null = could not read. The
 * local answer only steers the default and the render — the platform
 * re-checks over public DNS and its answer is authoritative, so a
 * split-horizon resolver never blocks a valid setup here.
 */
async function lookupMxForRender(
  dns: Pick<EmailDns, 'resolveMx'>,
  name: string,
): Promise<Array<string> | null> {
  try {
    const records = await dns.resolveMx(name);
    return records
      .slice()
      .sort((a, b) => a.priority - b.priority)
      .map((r) => r.exchange.replace(/\.$/, '').toLowerCase());
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    return code === 'ENODATA' || code === 'ENOTFOUND' ? [] : null;
  }
}

type EnterRace = { promise: Promise<'enter'>; stop: () => void };

/**
 * The "Enter switches paths" race from 0078's flow. The default reads one
 * cooked-mode line from stdin; `stop` removes the listener so a losing race
 * cannot eat the first keystroke of a later prompt.
 */
function createEnterRace(waitForEnter?: () => Promise<unknown>): EnterRace {
  if (waitForEnter) {
    return { promise: waitForEnter().then((): 'enter' => 'enter'), stop: () => {} };
  }
  const stdin = process.stdin;
  let onData: (() => void) | undefined;
  const promise = new Promise<'enter'>((resolve) => {
    if (!stdin.isTTY) {
      return; // Never resolves — non-interactive is gated before any race starts.
    }
    onData = () => resolve('enter');
    stdin.on('data', onData);
  });
  return {
    promise,
    stop: () => {
      if (onData) {
        stdin.removeListener('data', onData);
      }
    },
  };
}

/** Seams for {@link emailDomainAdd} — every browser, clipboard, DNS, and stdin touch is injectable. */
export interface EmailDomainAddDeps {
  dns?: Pick<EmailDns, 'resolveMx'>;
  /** The OAuth grant (default: the real PKCE flow in cf-oauth.ts). */
  runGrant?: (options: {
    onUrl?: (url: string) => void;
    signal?: AbortSignal;
  }) => Promise<CfOauthGrant>;
  /** Browser open for the template link (default: auth.ts's openBrowser). */
  openUrl?: (url: string) => void;
  /** Clipboard read; null means no clipboard tool — the paste prompt is the path. */
  readClipboard?: () => string | null;
  clearClipboard?: () => void;
  /** The CF-side active check (default: GET /user/tokens/verify). */
  verifyToken?: (token: string) => Promise<CfTokenVerification>;
  /** The masked paste prompt; null means the user cancelled (Esc). */
  pasteToken?: () => Promise<string | null>;
  /** The Enter keypress that switches paths (default: one stdin line). */
  waitForEnter?: () => Promise<unknown>;
  watchIntervalMs?: number;
  /** Default 10 minutes (0078's clipboard watch bound). */
  watchTimeoutMs?: number;
  /** Sleep between reconcile polls after a lost add answer (default: setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Default: wrangler's interactivity gate, same as `void email setup`. */
  isInteractive?: boolean;
  exit?: (code: number) => never;
}

async function defaultPasteToken(): Promise<string | null> {
  const result = await password({
    message: 'Paste the Cloudflare API token:',
    mask: '*',
  });
  if (isCancel(result) || typeof result === 'symbol') {
    return null;
  }
  return result;
}

type EmailDomainCredential =
  | { kind: 'oauth_grant'; refreshToken: string }
  | { kind: 'api_token'; apiToken: string };

/**
 * Lost-answer reconcile bounds for `domain add`: attempt-count bounded (not
 * wall clock) so the worst case is finite and tests are deterministic. The
 * API's pre-insert phase is DB-only but takes tens of ms to seconds of
 * Hyperdrive RTTs, and a lost answer does not stop the API worker — a single
 * immediate status read can 404 while the POST is still committing.
 */
const ADD_RECONCILE_ATTEMPTS = 15;
const ADD_RECONCILE_INTERVAL_MS = 1000;

/**
 * `void email domain add <domain>` — exported for the unit test; the command
 * entry resolves the client and project first.
 *
 * The flow (0078, "The flow"): render the MX decision → the OAuth grant →
 * the template-link + clipboard fallback (Enter switches to the masked paste
 * at any point) → POST the credential once → render the resulting row. A
 * failed add leaves the platform row 'failed' and re-running add replaces
 * the credential — the api's replace path, not anything here. On an
 * administrator-managed platform, only a row the owner registered before
 * the switch continues into that renewal flow.
 */
export async function emailDomainAdd(
  client: Pick<
    PlatformClient,
    'addEmailDomain' | 'getEmailDomain' | 'getEmailSettings' | 'listEmailDomains'
  >,
  projectId: string,
  rawDomain: string,
  subdomain: string | undefined,
  deps: EmailDomainAddDeps = {},
): Promise<void> {
  const exit = deps.exit ?? ((code: number): never => process.exit(code));
  const fail = (message: string): never => {
    log.error(message);
    return exit(1);
  };

  const domain = normalizeEmailDomainInput(rawDomain);
  if (!isValidEmailDomainInput(domain)) {
    return fail(`email: invalid domain '${rawDomain}'.`);
  }
  let target: { emailDomain: string; forced: boolean };
  try {
    target = resolveEmailDomainTarget(domain, subdomain);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  // The MX decision. Forced (--subdomain) needs no default, only a warning
  // when the named host already carries MX; unforced reads the apex and
  // falls back to mail.<domain>. Shared by the owner flow and the printed
  // administrator command, so the handoff names the target setup accepts.
  const dns = deps.dns ?? (await createNodeEmailDns());
  const decideTarget = async (): Promise<void> => {
    if (target.forced) {
      const mx = await lookupMxForRender(dns, target.emailDomain);
      if (mx !== null && mx.length > 0) {
        log.warn(
          `MX        ${target.emailDomain} already carries MX (${mx.join(', ')}) — the platform re-checks over public DNS and may refuse it.`,
        );
      }
    } else {
      const mx = await lookupMxForRender(dns, domain);
      if (mx === null) {
        log.info(
          `MX        could not read ${domain}'s MX from here — the platform decides over public DNS.`,
        );
      } else if (mx.length > 0) {
        target = { emailDomain: `mail.${domain}`, forced: false };
        log.info(
          `MX        ${domain} carries MX for ${mx[0]} → apex is off limits\n          using ${target.emailDomain}  [change with --subdomain]`,
        );
        const subMx = await lookupMxForRender(dns, target.emailDomain);
        if (subMx !== null && subMx.length > 0) {
          log.warn(
            `MX        ${target.emailDomain} also carries MX (${subMx.join(', ')}) — the platform may refuse it; pick another with --subdomain.`,
          );
        }
      } else {
        log.info(`MX        ${domain} has no MX records → using the apex`);
      }
    }
  };

  // On an administrator-managed platform owners normally hold no Cloudflare
  // credential, so there is no grant to open a browser for. The handoff does
  // DNS and the two platform GETs, never a Cloudflare call or browser flow. A
  // row the owner registered before the switch stays theirs to renew
  // (ownership table: add on an owner row), so that owner flow continues for
  // an existing target.
  let renewal: string | undefined;
  const settings = await client.getEmailSettings(projectId);
  if (settings.domains.management === 'admin') {
    const rows = await client.listEmailDomains(projectId);
    const candidates = [target.emailDomain, ...(target.forced ? [] : [`mail.${domain}`])];
    const existing = candidates
      .map((candidate) =>
        rows.find((row) => row.domain === candidate && row.managed_by !== 'admin'),
      )
      .find((row) => row !== undefined);
    if (!existing) {
      await decideTarget();
      const project = settings.domains.projectSlug ?? projectId;
      log.info(
        [
          'Email domains on this platform are managed by its administrator.',
          'Ask them to run:',
          '',
          `  void platform email domain-add ${target.emailDomain} --project ${project}`,
          '',
          '`void email domain list` and `void email domain status` keep working here.',
        ].join('\n'),
      );
      return exit(0);
    }
    // The pre-switch row IS the target: Email Routing itself put MX on the
    // apex it serves, so the MX decision below would retarget a renewal.
    renewal = existing.domain;
    target = { emailDomain: existing.domain, forced: true };
  }

  // A renewal keeps its stored target: Email Routing itself put MX on the
  // apex it serves, so the MX decision would retarget it.
  if (renewal !== undefined) {
    log.info(`Renewing ${renewal} — the stored credential is replaced; rules and the relay stay.`);
  } else {
    await decideTarget();
  }

  // Both grant paths need a human: a browser, a clipboard, or a paste prompt.
  const interactive = deps.isInteractive ?? !isWranglerNonInteractiveOrCI();
  if (!interactive) {
    return fail(
      'email: `void email domain add` needs an interactive terminal (the grant opens a browser; the fallback reads the clipboard or a paste). Run it locally.',
    );
  }

  // 1. The OAuth grant on wrangler's client (cf-oauth.ts). Enter switches to
  //    the template-link path mid-wait; any failure falls through to it too —
  //    the borrowed client id is not ours, so the fallback is permanent.
  let credential: EmailDomainCredential | undefined;
  const runGrant = deps.runGrant ?? ((options) => runCfOauthGrant(options));
  const grantSpinner = createSpinner();
  grantSpinner.start("Opening Cloudflare's consent page…");
  const controller = new AbortController();
  const enterDuringGrant = createEnterRace(deps.waitForEnter);
  const grantOutcome = await Promise.race([
    runGrant({
      signal: controller.signal,
      onUrl: (url) =>
        grantSpinner.message(
          `Waiting for the Cloudflare grant — click Allow. If the browser didn't open, visit:\n${pc.cyan(url)}\n(Enter switches to the API-token path.)`,
        ),
    }).then(
      (grant) => ({ type: 'grant' as const, grant }),
      (error: unknown) => ({
        type: 'error' as const,
        error: error instanceof Error ? error : new Error(String(error)),
      }),
    ),
    enterDuringGrant.promise.then(() => ({ type: 'enter' as const })),
  ]);
  enterDuringGrant.stop();
  if (grantOutcome.type === 'grant') {
    grantSpinner.stop('Grant received.');
    credential = { kind: 'oauth_grant', refreshToken: grantOutcome.grant.refreshToken };
  } else {
    controller.abort();
    grantSpinner.stop(
      grantOutcome.type === 'enter'
        ? 'Switched to the API-token path.'
        : 'The consent flow did not complete — using the API-token path.',
    );
    if (grantOutcome.type === 'error') {
      log.warn(grantOutcome.error.message);
    }
  }

  // 2. The template link + clipboard watch (0078, "Creating the token in
  //    three clicks"). The clipboard is read only between opening the link
  //    and getting a token, only a NEW value shaped like a CF token is
  //    accepted, and the clipboard is cleared once it arrives.
  if (credential === undefined) {
    const url = buildCfApiTokenTemplateUrl(target.emailDomain);
    const readClip = deps.readClipboard ?? readClipboard;
    const clearClip = deps.clearClipboard ?? clearClipboard;
    const verify = deps.verifyToken ?? verifyCfApiToken;
    const openUrl =
      deps.openUrl ??
      ((u: string): void => {
        void import('node:child_process').then(({ execFile }) => openBrowser(u, execFile));
      });
    const snapshot = readClip();
    if (snapshot === null) {
      log.info('No clipboard tool found here — paste the token instead.');
    }
    openUrl(url);

    type WatchOutcome = { type: 'token'; token: string } | { type: 'enter' } | { type: 'timeout' };
    let outcome: WatchOutcome;
    let watchSpinner: ReturnType<typeof createSpinner> | undefined;
    if (snapshot === null) {
      outcome = { type: 'timeout' };
    } else {
      watchSpinner = createSpinner();
      watchSpinner.start(
        [
          'Create the token in three clicks: Continue to summary → Create Token → Copy.',
          'Watching the clipboard for it — nothing is read until you copy, and it is cleared afterwards.',
          '(Enter pastes it yourself instead.)',
          `If the browser didn't open, visit:\n${pc.cyan(url)}`,
        ].join('\n'),
      );
      const spinner = watchSpinner;
      const deadline = Date.now() + (deps.watchTimeoutMs ?? 10 * 60 * 1000);
      const interval = deps.watchIntervalMs ?? 1000;
      const snapshotTrimmed = snapshot.trim();
      const enterDuringWatch = createEnterRace(deps.waitForEnter);
      // Either race outcome must stop the poll branch: an orphaned loop would
      // keep reading the clipboard on ref'd timers to the deadline (and could
      // verify a later token-shaped value) after the flow has moved on.
      let watchSettled = false;
      let watchTimer: ReturnType<typeof setTimeout> | undefined;
      outcome = await Promise.race([
        (async (): Promise<WatchOutcome> => {
          while (!watchSettled && Date.now() < deadline) {
            await new Promise<void>((resolve) => {
              watchTimer = setTimeout(resolve, interval);
            });
            if (watchSettled) {
              break;
            }
            const value = readClip()?.trim();
            if (!value || value === snapshotTrimmed) {
              continue;
            }
            const shape = classifyCfApiTokenShape(value);
            // Wrong shape (another vendor's token included): nothing — still
            // waiting, and never a network call for it (0078's branch table).
            if (shape === 'refused' || shape === 'unknown') {
              continue;
            }
            const verdict = await verify(value);
            if (verdict === 'inactive') {
              spinner.message('That is not an active Cloudflare token — still waiting.');
              continue;
            }
            if (verdict === 'unknown') {
              log.info(
                'Could not reach Cloudflare to check the token — the platform will verify it.',
              );
            }
            return { type: 'token', token: value };
          }
          return { type: 'timeout' };
        })(),
        enterDuringWatch.promise.then((): WatchOutcome => ({ type: 'enter' })),
      ]);
      watchSettled = true;
      enterDuringWatch.stop();
      // Unref the timer the losing poll branch is parked on — it wakes once,
      // sees the flag and exits; it must not keep the process alive meanwhile.
      watchTimer?.unref();
    }

    if (outcome.type === 'token') {
      clearClip();
      watchSpinner?.stop('Token received — the clipboard copy was cleared.');
      // Said once, per 0078: a clipboard manager's history is outside our reach.
      log.info('A clipboard manager may keep its own history — clear it there if you run one.');
      credential = { kind: 'api_token', apiToken: outcome.token };
    } else {
      watchSpinner?.stop(
        outcome.type === 'enter' ? 'Pasting instead.' : 'No token arrived — paste it instead.',
      );
      const pasted = await (deps.pasteToken ?? defaultPasteToken)();
      if (pasted === null) {
        // Esc: cancel with nothing stored anywhere (0078's branch table).
        log.info('Cancelled — nothing was stored anywhere.');
        return;
      }
      const token = pasted.trim();
      const shape = classifyCfApiTokenShape(token);
      if (shape === 'refused') {
        return fail(
          'email: that looks like a different kind of token (a GitHub, OpenAI, Slack, or Cloudflare global key) — the link above creates a scoped Cloudflare API token.',
        );
      }
      if (shape === 'unknown') {
        return fail(
          'email: that is not shaped like a Cloudflare API token (`cfut_…` or the legacy 40-character form). Create one from the link above.',
        );
      }
      const verdict = await verify(token);
      if (verdict === 'inactive') {
        return fail('email: that is not an active Cloudflare token.');
      }
      if (verdict === 'unknown') {
        log.info('Could not reach Cloudflare to check the token — the platform will verify it.');
      }
      credential = { kind: 'api_token', apiToken: token };
    }
  }

  // 3. The one call that carries the credential. Everything after it
  //    (status, sync, remove) addresses the row by domain. The attempt id
  //    is stamped on the row by the api, so a reconcile after a lost answer
  //    can tell this attempt's committed row apart from a pre-existing one.
  const attemptId = crypto.randomUUID();
  let row: EmailDomainResponse;
  try {
    row = await client.addEmailDomain(projectId, {
      domain: target.emailDomain,
      ...(credential.kind === 'oauth_grant'
        ? { refreshToken: credential.refreshToken }
        : { apiToken: credential.apiToken }),
      attemptId,
    });
  } catch (err) {
    if (
      err instanceof PlatformApiError &&
      (err.status === 400 || err.status === 404 || err.status === 409)
    ) {
      // Only the add route's deliberate rejections rethrow: it revokes a
      // posted grant server-side before answering any of these, and the
      // error names the reason. 403 is NOT in this set — the platform's
      // middleware answers 403 pre-route (a suspended account, a
      // deploy-token scope refusal) without ever parsing the body, so a
      // 403 proves nothing about the grant and reconciles like any other
      // ambiguous answer.
      throw err;
    }
    // A transport failure (DNS, a connection reset, a lost answer) OR an
    // ambiguous answer (403, 5xx, or a 401/413/426/429 from middleware or
    // the edge) leaves the add's outcome unknown: the request may never
    // have reached the route, it may have failed before the grant was
    // stored or revoked, or it COMMITTED and only the outcome was lost.
    // The CLI holds the only copy of a freshly minted grant, so reconcile
    // before anything irreversible — a committed row is the grant's
    // revocation handle, and only a definitive "not on the row" makes a
    // CLI-side revoke safe (revoking a stored-and-unrotated grant would
    // brick the row it belongs to).
    const sleep =
      deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    // The last informative read picks the deadline branch: a row carrying a
    // DIFFERENT attempt id means the platform kept the row's existing
    // credential; a 404 means nothing persisted (yet).
    let lastRead: 'foreign' | 'missing' | undefined;
    for (let attempt = 0; attempt < ADD_RECONCILE_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await sleep(ADD_RECONCILE_INTERVAL_MS);
      }
      let existing: EmailDomainStatusResponse;
      try {
        existing = await client.getEmailDomain(projectId, target.emailDomain);
      } catch (statusErr) {
        if (statusErr instanceof PlatformApiError && statusErr.status === 404) {
          lastRead = 'missing';
        }
        // Any other error is no read at all — keep polling.
        continue;
      }
      if ('attemptId' in existing) {
        if (existing.attemptId === attemptId) {
          // My POST committed. NEVER revoke — the row is the grant's handle.
          log.warn(
            "The add's answer was lost (network or platform error), but the platform has the row.",
          );
          printEmailDomainOutcome(existing);
          return;
        }
        // Not mine (yet) — my in-flight POST could still commit a replace
        // stamping this id, so keep polling to the deadline.
        lastRead = 'foreign';
        continue;
      }
      // An api without attempt identity (the key is absent): this could be
      // my add committed there, indistinguishable from a pre-existing row.
      // Trust the row like the pre-attempt flow did — NEVER revoke.
      log.warn(
        "The add's answer was lost (network or platform error), but the platform has the row.",
      );
      printEmailDomainOutcome(existing);
      return;
    }
    if (lastRead === 'foreign') {
      // The row settled on another attempt id (or none), so this attempt's
      // credential was never stored — a committed mine would have stamped
      // my id. The revoke cannot brick the row.
      if (credential.kind === 'oauth_grant') {
        const revoked = await revokeCfOauthGrant(credential.refreshToken);
        return fail(
          revoked
            ? `email: the add did not complete, and ${target.emailDomain} kept the row's existing credential; the OAuth grant minted for this attempt was revoked — re-run to retry the replace.`
            : `email: the add did not complete, and ${target.emailDomain} kept the row's existing credential; the OAuth grant minted for this attempt could not be revoked — revoke it in the Cloudflare dashboard, then re-run to retry the replace.`,
        );
      }
      return fail(
        `email: the add did not complete, and ${target.emailDomain} kept the row's existing credential. The token was not stored anywhere; delete it in the Cloudflare dashboard if you are not retrying.`,
      );
    }
    if (lastRead === 'missing') {
      // 404 at every poll — provably nothing persisted. The minted grant's
      // only copy is in this process: revoke it rather than strand it live
      // (an api_token has no revoke primitive — the customer deletes it
      // themselves).
      if (credential.kind === 'oauth_grant') {
        const revoked = await revokeCfOauthGrant(credential.refreshToken);
        return fail(
          revoked
            ? `email: the add did not complete — ${target.emailDomain} was not registered, and the OAuth grant minted for this attempt was revoked.`
            : `email: the add did not complete — ${target.emailDomain} was not registered; the OAuth grant minted for this attempt could not be revoked — revoke it in the Cloudflare dashboard before retrying.`,
        );
      }
      return fail(
        `email: the add did not complete — ${target.emailDomain} was not registered. The token was not stored anywhere; delete it in the Cloudflare dashboard if you are not retrying.`,
      );
    }
    // No poll produced any read — the add's state is unknown, and a blind
    // revoke could brick a committed row: report, don't revoke.
    return fail(
      `email: the add did not complete, and the follow-up check failed too — the add's state is unknown, so nothing was revoked. A grant minted for this attempt may still be live: once connectivity is back, run \`void email domain status ${target.emailDomain}\`; if it shows no row, revoke the grant in the Cloudflare dashboard before retrying.`,
    );
  }
  log.success(
    credential.kind === 'oauth_grant'
      ? 'Grant stored on the platform, encrypted for this project — nothing is kept on this machine.'
      : 'Token stored on the platform, encrypted for this project — nothing is kept on this machine.',
  );
  printEmailDomainOutcome(row);
}

/** An administrator's row runs on the platform's own credential; the owner never held one. */
function emailCredentialLabel(row: Pick<EmailDomainResponse, 'credential_kind' | 'managed_by'>) {
  const kind =
    row.credential_kind === 'oauth_grant'
      ? 'OAuth grant'
      : row.credential_kind === 'platform'
        ? 'platform credential'
        : 'API token';
  return row.managed_by === 'admin' ? `${kind} · managed by the administrator` : kind;
}

function emailDomainStatusText(status: EmailDomainResponse['status']): string {
  if (status === 'active') {
    return pc.green('active');
  }
  if (status === 'pending') {
    return pc.yellow('pending');
  }
  return pc.red(status === 'failed' ? 'failed' : status.replace('_', ' '));
}

/**
 * The dashboard path for the one remaining human step. The row does not
 * carry the zone name, so a subdomain row strips its first label — the zone
 * the walk almost always lands on (`mail.acme.com` → `acme.com`).
 */
function routingSubdomainInstruction(domain: string, mode: EmailDomainResponse['mode']): string {
  const zoneGuess = mode === 'subdomain' ? domain.split('.').slice(1).join('.') : domain;
  return `add ${domain} in the Cloudflare dashboard — Email Routing → ${zoneGuess} → Settings → Subdomains (no API exists for it)`;
}

/**
 * The shared result render for add and sync: the row as a block, then the
 * one guidance line the status calls for. `error` is printed verbatim — the
 * api guarantees it names a step or a CF error, never credential material.
 */
function printEmailDomainOutcome(row: EmailDomainResponse): void {
  if (row.status === 'failed') {
    const step = row.setup_state?.failed_step;
    log.error(
      `email: ${row.domain} failed${step ? ` at ${step.replaceAll('_', ' ')}` : ''}${row.error ? ` — ${row.error}` : ''}`,
    );
    log.info(
      `Fix the step above, then re-run \`void email domain add ${row.domain}\` — adding again replaces the credential and retries.`,
    );
    return;
  }

  const lines = [
    `Domain:      ${row.domain}`,
    `Status:      ${emailDomainStatusText(row.status)}`,
    `Mode:        ${row.mode ?? '—'}`,
    `Credential:  ${emailCredentialLabel(row)}`,
  ];
  if (row.relay_worker_name) {
    lines.push(
      `Relay:       ${row.relay_worker_name}${row.relay_version !== null ? ` v${row.relay_version}` : ''}`,
    );
  }
  if (row.token_expires_on) {
    lines.push(`Token TTL:   expires ${row.token_expires_on}`);
  }
  note(lines.join('\n'), 'Email Domain');

  const remaining = row.setup_state?.remaining_steps ?? [];
  if (row.status === 'pending' && remaining.includes('routing_subdomain')) {
    log.warn(`One step only you can do: ${routingSubdomainInstruction(row.domain, row.mode)}.`);
    log.info(`Then run \`void email domain status ${row.domain}\` to poll.`);
    return;
  }
  if (row.status === 'pending') {
    log.info(`Run \`void email domain status ${row.domain}\` to poll.`);
    return;
  }
  if (row.status === 'token_revoked' || row.status === 'token_expired') {
    log.warn(
      `The stored credential was ${row.status === 'token_revoked' ? 'revoked at Cloudflare' : 'left to expire'} — re-run \`void email domain add ${row.domain}\` with a fresh grant or token. Rules and the relay stay.`,
    );
    return;
  }
  if (remaining.includes('sending_onboarding')) {
    log.info(
      `Inbound is live. Sending to arbitrary recipients needs Workers Paid — until then sendEmail() works to verified destinations only. After upgrading, run \`void email domain sync ${row.domain}\` to finish onboarding.`,
    );
  }
  log.success(
    `${row.domain} is live — send with \`sendEmail({ from: 'you@${row.domain}', … })\`; inbound mail to any address on ${row.domain} reaches your email/ handlers.`,
  );
}

/**
 * `void email domain status <domain>` — exported for the unit test. Re-probes
 * the credential and the relay on every call (the api does it), so this is
 * also the drift report: it never fights the customer's edits, it names them.
 */
export async function emailDomainStatus(
  client: Pick<PlatformClient, 'getEmailDomain' | 'getEmailSettings'>,
  projectId: string,
  rawDomain: string,
): Promise<void> {
  const domain = normalizeEmailDomainInput(rawDomain);
  const row: EmailDomainStatusResponse = await client.getEmailDomain(projectId, domain);
  const adminRow = row.managed_by === 'admin';

  const lines = [
    `Domain:      ${row.domain}`,
    `Status:      ${emailDomainStatusText(row.status)}`,
    `Mode:        ${row.mode ?? '—'}`,
  ];
  const credential =
    row.credential_status === 'probe_failed'
      ? `${emailCredentialLabel(row)} · probe failed (stored view shown)`
      : `${emailCredentialLabel(row)} · ${row.credential_status}`;
  lines.push(`Credential:  ${credential}`);
  if (row.token_id) {
    lines.push(
      `Token:       id ${row.token_id}${row.token_expires_on ? ` · expires ${row.token_expires_on}` : ''}`,
    );
  }
  if (row.relay_worker_name) {
    let relay = `Relay:       ${row.relay_worker_name}${row.relay_version !== null ? ` v${row.relay_version}` : ''}`;
    if (row.relay_missing === true) {
      relay += ' · missing from the account';
    } else if (row.relay_drift) {
      relay += ` · drifted (current is v${row.current_relay_version})`;
    }
    lines.push(relay);
  }
  if (row.setup_state?.failed_step) {
    lines.push(`Failed step: ${row.setup_state.failed_step.replaceAll('_', ' ')}`);
  }
  lines.push(`Catch-all:   ${row.catch_all}`);
  note(lines.join('\n'), 'Email Domain');

  if (row.error) {
    log.error(`email: ${row.error}`);
  }
  const failedAdminRow = adminRow && row.status === 'failed';
  if (failedAdminRow) {
    const slug = (await client.getEmailSettings(projectId)).domains.projectSlug ?? projectId;
    log.warn(
      `Ask your administrator to re-run the setup: \`void platform email domain-add ${row.domain} --project ${slug}${row.credential_kind === 'api_token' ? ' --token-stdin' : ''}\` — adding again retries the failed step; rules stay.`,
    );
  }
  const remaining = row.setup_state?.remaining_steps ?? [];
  if (remaining.includes('routing_subdomain')) {
    log.warn(
      adminRow
        ? `One step for your administrator, in the platform's Cloudflare account: ${routingSubdomainInstruction(row.domain, row.mode)}.`
        : `One step only you can do: ${routingSubdomainInstruction(row.domain, row.mode)}.`,
    );
  }
  if (remaining.includes('sending_onboarding')) {
    log.info(
      adminRow
        ? `Sending to arbitrary recipients needs Workers Paid on the platform's Cloudflare account — inbound works; sendEmail() to verified destinations only. After the upgrade, ask your administrator to run \`void platform email domain-sync ${row.domain}\`.`
        : `Sending to arbitrary recipients needs Workers Paid — inbound works; sendEmail() to verified destinations only. After upgrading, run \`void email domain sync ${row.domain}\`.`,
    );
  }
  if (!failedAdminRow && (row.relay_missing === true || row.relay_drift)) {
    log.info(
      adminRow
        ? `Ask your administrator to run \`void platform email domain-sync ${row.domain}\` to redeploy the relay in place.`
        : `Run \`void email domain sync ${row.domain}\` to redeploy the relay in place.`,
    );
  }
  if (!failedAdminRow && row.catch_all_drift) {
    log.info(
      adminRow
        ? `Catch-all drifted — ask your administrator to run \`void platform email domain-sync ${row.domain}\` to re-point it.`
        : `Catch-all drifted — run \`void email domain sync ${row.domain}\` to re-point it.`,
    );
  }
  if (row.status === 'token_revoked' || row.status === 'token_expired') {
    if (adminRow) {
      const slug = (await client.getEmailSettings(projectId)).domains.projectSlug ?? projectId;
      log.warn(
        `Ask your administrator to re-add it: \`void platform email domain-add ${row.domain} --project ${slug} --token-stdin\` — adding again replaces the credential, rules stay.`,
      );
    } else {
      log.warn(
        `Re-run \`void email domain add ${row.domain}\` with a fresh grant or token — adding again replaces the credential, rules stay.`,
      );
    }
  }
}

/** `void email domain list` — exported for the unit test. */
export async function emailDomainList(
  client: Pick<PlatformClient, 'listEmailDomains'>,
  projectId: string,
): Promise<void> {
  const rows = await client.listEmailDomains(projectId);
  if (rows.length === 0) {
    log.info(
      'No email domains. Run `void email domain add <domain>` to send and receive at your own domain on a Cloudflare zone.',
    );
    return;
  }
  const width = Math.max(...rows.map((row) => row.domain.length));
  const lines = rows.map(
    (row) =>
      `  ${row.domain.padEnd(width)}  ${emailDomainStatusText(row.status)}  ${row.mode ?? '—'}`,
  );
  note(lines.join('\n'), 'Email Domains');
}

/** `void email domain sync <domain>` — exported for the unit test. */
export async function emailDomainSync(
  client: Pick<PlatformClient, 'syncEmailDomain'>,
  projectId: string,
  rawDomain: string,
): Promise<void> {
  const domain = normalizeEmailDomainInput(rawDomain);
  const row = await client.syncEmailDomain(projectId, domain);
  if (row.status !== 'failed') {
    log.success(
      `Relay redeployed${row.relay_version !== null ? ` at v${row.relay_version}` : ''} with a rotated secret.`,
    );
    // catch_all is absent when the row carries no zone_id.
    if (row.catch_all === 'foreign_conflict') {
      log.warn(
        "Catch-all: the zone's catch-all points at a different worker and was NOT overwritten — change it in the zone's Email Routing settings if inbound mail should reach this relay.",
      );
    } else if (row.catch_all !== undefined) {
      log.info(`Catch-all: ${row.catch_all.replaceAll('_', ' ')}`);
    }
  }
  printEmailDomainOutcome(row);
}

/** `void email domain remove <domain>` — exported for the unit test. */
export async function emailDomainRemove(
  client: Pick<PlatformClient, 'removeEmailDomain'>,
  projectId: string,
  rawDomain: string,
  options: { force?: boolean; exit?: (code: number) => never } = {},
): Promise<void> {
  const domain = normalizeEmailDomainInput(rawDomain);
  const result = await client.removeEmailDomain(projectId, domain, options.force);

  if (!result.removed) {
    // Kept for retry: a Cloudflare-side step failed without --force, so the
    // row (and the stored credential the retry needs) stays.
    const steps = result.failed_steps?.length ? result.failed_steps.join(', ') : 'unknown';
    log.error(`email: could not remove ${domain} — failed Cloudflare-side steps: ${steps}.`);
    log.info(
      `The registration was kept — retry \`void email domain remove ${domain}\` once the Cloudflare-side problem is fixed, or re-run with --force to drop the row anyway.`,
    );
    (options.exit ?? ((code: number): never => process.exit(code)))(1);
  }

  log.success(
    `Removed ${domain} — the platform row, the stored credential and the relay secret are gone.`,
  );
  const failed = result.failed_steps ?? [];
  if (
    failed.length > 0 &&
    (result.forced === true || failed.some((step) => step !== 'revoke_grant'))
  ) {
    log.warn(
      `Cloudflare-side cleanup failed for: ${failed.join(', ')} — delete the relay worker and reset the catch-all in the zone's Email Routing settings yourself.`,
    );
  } else if (failed.length > 0) {
    // Only the grant revoke failed: the rules and relay are already gone.
    log.info(
      'Note: the Cloudflare grant could not be revoked (already invalid or Cloudflare unreachable) — no mail impact.',
    );
  }
}

async function runEmailDomainCommand(
  client: PlatformClient,
  projectId: string,
  args: EmailArgs,
): Promise<void> {
  switch (args.domainVerb) {
    case 'add':
      return emailDomainAdd(client, projectId, args.domain!, args.subdomain);
    case 'status':
      return emailDomainStatus(client, projectId, args.domain!);
    case 'list':
      return emailDomainList(client, projectId);
    case 'sync':
      return emailDomainSync(client, projectId, args.domain!);
    case 'remove':
      return emailDomainRemove(client, projectId, args.domain!, { force: args.force });
  }
}

// ── Mode B: the developer's own Cloudflare account ─────────────────────────────

/**
 * Seams for {@link runEmailCloudflareCommand}, so the command is unit-testable with no
 * wrangler, network, DNS, terminal, or Cloudflare account — the same pattern the deploy
 * orchestrator's `CloudflareDeployDeps` uses.
 */
export interface EmailCloudflareCommandDeps {
  /** wrangler runner for the read-only probes and the `email … enable` writes. */
  runWrangler?: EmailWranglerRun;
  /** The session-bearer bridge (default: `wrangler auth token --json`, logs off). */
  getSessionBearer?: () => Promise<string | null>;
  fetchImpl?: EmailFetch;
  dns?: EmailDns;
  /** Override the interactivity gate (default: wrangler's own, `!isWranglerNonInteractiveOrCI()`). */
  isInteractive?: boolean;
  /** The one Enter (default: clack `confirm`, default Yes). */
  confirm?: (message: string) => Promise<boolean>;
  /** Block printer for the checklist / address map (default: clack `log.message`). */
  print?: (block: string) => void;
  exit?: (code: number) => never;
}

/**
 * `void email setup --platform cloudflare` and `void email status --platform cloudflare`.
 *
 * `setup` is the deploy's step 3b-ii on its own: preflight → checklist → the one Enter →
 * apply → write the root wrangler.jsonc. It exists for CI: a non-interactive deploy that
 * finds email not ready prints the checklist and says to run this once, commit
 * wrangler.jsonc, and redeploy. Rules and the catch-all stay wrangler's job — the next
 * `void deploy --platform cloudflare` applies the plan from the written `addresses`. It
 * is also the ONLY place a sending onboarding the committed binding remembers as refused
 * (Workers Free) is retried — on its own prompt, after a Workers Paid upgrade; the deploy
 * reads that row as settled and never retries it.
 *
 * `status` is the preflight alone, printed, exit 1 when not ready.
 */
export async function runEmailCloudflareCommand(
  root: string,
  args: EmailArgs,
  deps: EmailCloudflareCommandDeps = {},
): Promise<void> {
  const exit = deps.exit ?? ((code: number): never => process.exit(code));
  const print = deps.print ?? ((block: string): void => log.message(block));
  const fail = (message: string): never => {
    log.error(message);
    return exit(1);
  };

  // 1. Inputs from the local project: `email.from` is the ONLY domain input (decision 9).
  const voidConfig = readConfig(root);
  const from = voidConfig.email?.from;
  if (!from) {
    return fail(
      'email: no sender configured. Add "email": { "from": "you@mail.acme.com" } to void.json — its host is the domain email is set up on.',
    );
  }
  const paths = readProjectPaths(root);
  const handlers = scanEmailHandlersSync(paths.sourceRoot);

  // 2. The same pinned transport + account + worker name as `void deploy --platform
  //    cloudflare`, so every wrangler child here consults the account the deploy will.
  const configPath = discoverRootWranglerConfig(root);
  const rootConfig = parseRootWranglerConfig(configPath);
  await loadProvisionModule();
  let apiBaseUrl: string;
  try {
    apiBaseUrl = resolveDeployTransport(root, rootConfig);
  } catch (err) {
    return fail(`email: ${err instanceof Error ? err.message : String(err)}`);
  }
  const accountId =
    readWranglerTopLevelString(rootConfig, 'account_id') ??
    (process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || undefined);
  if (!accountId) {
    return fail(
      [
        'email: no Cloudflare account is pinned.',
        'Set `account_id` in your root wrangler.jsonc, or export CLOUDFLARE_ACCOUNT_ID —',
        'the same pin `void deploy --platform cloudflare` needs.',
      ].join('\n'),
    );
  }
  const workerName = readWranglerTopLevelString(rootConfig, 'name') ?? deriveWorkerName(root);
  const runWrangler = deps.runWrangler ?? createDeployWranglerRunner(root, accountId, apiBaseUrl);
  // The same bearer bridge the deploy's step 3b-ii uses: `wrangler auth token --json` on the
  // pinned runner, WRANGLER_WRITE_LOGS=false so the token never reaches wrangler's on-disk log.
  const getSessionBearer =
    deps.getSessionBearer ?? (() => runWranglerAuthToken(runWrangler, configPath));
  const sendEmail = rootConfig.send_email;
  const inputs: EmailCloudflareInputs = {
    handlers,
    from,
    workerName,
    accountId,
    existingSendEmail: Array.isArray(sendEmail) ? (sendEmail as Array<{ name?: unknown }>) : null,
    existingAddresses: rootConfig.addresses,
    existingVars:
      rootConfig.vars && typeof rootConfig.vars === 'object' && !Array.isArray(rootConfig.vars)
        ? (rootConfig.vars as Record<string, unknown>)
        : null,
    configConflicts: findEmailConfigConflicts(rootConfig),
    wranglerArgs: ['-c', configPath, '--env='],
    apiBaseUrl,
    runWrangler,
    getSessionBearer,
    fetchImpl: deps.fetchImpl ?? fetch,
    dns: deps.dns ?? (await createNodeEmailDns()),
  };

  // 3. Preflight — read-only.
  let pre: EmailPreflight;
  try {
    pre = await preflightEmail(inputs);
  } catch (err) {
    return fail(`email: ${err instanceof Error ? err.message : String(err)}`);
  }
  print(renderEmailChecklist(pre));

  if (args.subcommand === 'status') {
    print(
      renderAddressMap({
        from,
        routes: pre.derived.routes,
        addresses: pre.rules.mine,
        sendingReady: pre.sending.state === 'ready',
        pendingLabel: '(no rule yet)',
      }),
    );
    if (pre.ready) {
      log.success(`Email is set up on ${pre.domain}.`);
      return;
    }
    log.warn(
      `Email is not set up on ${pre.domain} yet — run \`void email setup --platform cloudflare\`.`,
    );
    return exit(1);
  }

  // 4. The one Enter. An `all` blocker means nothing can be applied; a ready preflight
  //    needs no prompt (apply makes zero calls and the config write is idempotent) — with
  //    one exception: a sending row the committed binding remembers as refused (Workers
  //    Free; `sendingRetryable`, see `preflightEmail`). Apply WOULD make that one `sending
  //    enable` call again, so it is offered as its own prompt — the retry after a Workers
  //    Paid upgrade, which the deploy never attempts — and is never run unasked.
  if (pre.blockers.some((b) => b.scope === 'all')) {
    return fail('email: nothing was changed — fix the ✘ rows above and rerun.');
  }
  if (!pre.ready || pre.sendingRetryable) {
    const interactive = deps.isInteractive ?? !isWranglerNonInteractiveOrCI();
    if (!interactive) {
      return fail(
        'email: `void email setup` changes your Cloudflare account, so it needs an interactive terminal. Run it locally once, commit wrangler.jsonc, then redeploy.',
      );
    }
    const ask =
      deps.confirm ??
      (async (message: string): Promise<boolean> => {
        const answer = await confirm({ message, initialValue: true });
        return !isCancel(answer) && answer === true;
      });
    const question = pre.ready
      ? `Onboard ${pre.domain} for Email Sending? Inbound already works; onboarding needs Workers Paid.`
      : `Set up email on ${pre.domain}?`;
    if (!(await ask(question))) {
      log.info('Nothing changed.');
      return;
    }
  }

  // 5. Apply, then write the root config through the one comment-preserving writer.
  const out = await applyEmailSetup(pre, inputs);
  if (out.lines.length > 0) {
    print(out.lines.join('\n'));
  }
  try {
    writeProvisionedWranglerConfig(root, out.patch, { configPath });
  } catch (err) {
    return fail(
      `email: could not update ${configPath} — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  print(
    renderAddressMap({
      from,
      routes: pre.derived.routes,
      addresses: out.patch.addresses ?? [],
      sendingReady: out.sendingReady,
      pendingLabel: '(no rule yet)',
    }),
  );
  // The inbound rows, not routing alone: a refused subaddressing PATCH after a successful
  // enable withholds `addresses`, so the next deploy creates no rule and `+tag` mail
  // matches nothing — "set up" would be false, and CI's `--require-email` (which gates on
  // the same `inboundReady`) would refuse the deploy this command exists to prepare. A
  // sending row that stays pending (Workers Free) is NOT a failure here: inbound is
  // complete, `addresses` is committed, the plan hint above is the warning, and the
  // binding written alongside is what the next preflight reads as the memory of that
  // refusal — so `void email status` and `--require-email` read this state as set up too.
  if (!out.inboundReady) {
    const missing = !out.routingReady
      ? `Email Routing on ${pre.domain} is not ready`
      : !out.subaddressingReady
        ? `subaddressing on ${pre.apex} is still off (support+anything@ would not reach support@)`
        : '`addresses` was withheld';
    log.warn(
      `Email is not set up on ${pre.domain} yet — ${missing}; no routing rule is created until it is. Finish the step above, then rerun \`void email setup --platform cloudflare\`.`,
    );
    return exit(1);
  }
  if ((out.patch.addresses ?? []).length > 0) {
    log.info(
      'Routing rules are created by the next `void deploy --platform cloudflare`, which applies the Email Routing plan from `addresses`.',
    );
  }
  log.success(`Email set up on ${pre.domain}.`);
}
