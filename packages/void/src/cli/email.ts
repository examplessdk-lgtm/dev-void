import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { confirm, isCancel, log, note, password } from '@clack/prompts';
import { parseRootWranglerConfig, readWranglerTopLevelString } from '@void/deploy-cloudflare';
import { join } from 'pathslash';
import { readConfig } from '../config.ts';
import { readProjectPaths } from '../project-paths.ts';
import { scanEmailHandlersSync } from '../router/email.ts';
import { getToken, openBrowser } from './auth.ts';
import { PlatformApiError, PlatformClient, type EmailDomainResponse } from './client.ts';
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
    log.error('Not logged in. Run `void account login` first.');
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
    `Month:              ${usage.month}`,
    `Status:             ${status}`,
    `Recipient attempts: ${usage.attempts} / ${usage.limit} (${usage.remaining} remaining)`,
    `Inbound receipts:   ${usage.received}`,
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
  log.success(
    `Removed ${dest.address}. New sends to it are refused immediately; already admitted attempts may finish.`,
  );
}

export async function emailLogs(
  client: Pick<PlatformClient, 'getEmailLogs'>,
  projectId: string,
  limit?: number,
): Promise<void> {
  const result = await client.getEmailLogs(projectId, limit);
  if (result.logs.length === 0) {
    log.info('No email activity recorded.');
    return;
  }
  const lines = result.logs.map((entry) => {
    const ts = new Date(entry.timestamp).toISOString();
    const dir = entry.direction === 'sent' ? '→' : '←';
    return `${ts}  ${dir}  ${entry.operationId}  ${entry.recipient ?? '—'}  ${entry.status}${entry.errorCode ? ` (${entry.errorCode})` : ''}`;
  });
  note(lines.join('\n'), 'Email Logs');
}

// ── Custom domains on the customer's own Cloudflare zone (0078) ──────────────
//
// `void email domain add|status|list|sync|remove`. The api owns the
// orchestration (contract 7); the CLI owns the MX-decision render, the
// scoped API token (the template link +
// clipboard watch below as the permanent fallback), and the result render.
// The pasted API token is held in
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

/** The three-click template link — the scoped token path (0078, "Creating the token in three clicks"). */
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

// Clipboard helpers — the read side mirrors the write side in account-cmd.ts
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
  /** Browser open for the template link (default: auth.ts's openBrowser). */
  openUrl?: (url: string) => void;
  /** Clipboard read; null means no clipboard tool — the paste prompt is the path. */
  readClipboard?: () => string | null;
  clearClipboard?: () => void;
  /** The CF-side active check (default: GET /user/tokens/verify). */
  verifyToken?: (token: string) => Promise<CfTokenVerification>;
  /** The masked paste prompt; null means the user cancelled (Esc). */
  pasteToken?: () => Promise<string | null>;
  /** Confirms the account/zone resource restriction shown in the token form. */
  confirmScope?: (domain: string) => Promise<boolean>;
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

type EmailDomainCredential = { kind: 'api_token'; apiToken: string };

/**
 * Lost-answer reconcile bounds for `domain add`: attempt-count bounded (not
 * wall clock) so the worst case is finite and tests are deterministic. The
 * API's pre-insert phase is DB-only but takes tens of ms to seconds of
 * Hyperdrive RTTs, and a lost answer does not stop the API worker — a single
 * immediate status read can 404 while the POST is still committing.
 */
const ADD_RECONCILE_ATTEMPTS = 15;
const ADD_RECONCILE_INTERVAL_MS = 1000;

export async function emailDomainAdd(
  client: Pick<
    PlatformClient,
    | 'addEmailDomain'
    | 'getEmailDomain'
    | 'getEmailOperation'
    | 'getEmailSettings'
    | 'listEmailDomains'
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
  if (subdomain !== undefined) {
    return fail(
      'email: Platform-managed custom email requires a Cloudflare zone apex because inbound email uses its catch-all. Omit --subdomain, choose an unused zone apex, or use the platform shared mail address.',
    );
  }
  let target: { emailDomain: string; forced: boolean };
  try {
    target = resolveEmailDomainTarget(domain, subdomain);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  // Keep the requested apex. The server checks DNS and zone authority again.
  const dns = deps.dns ?? (await createNodeEmailDns());
  const decideTarget = async (): Promise<void> => {
    const mx = await lookupMxForRender(dns, domain);
    if (mx === null) {
      log.info(
        `MX        could not read ${domain}'s MX from here — the platform decides over public DNS.`,
      );
    } else if (mx.some((exchange) => !/\.mx\.cloudflare\.net$/i.test(exchange))) {
      fail(
        `email: ${domain} already receives mail from another provider. Platform custom inbound email requires an unused Cloudflare zone apex; choose another apex or use the platform shared mail address.`,
      );
    } else {
      log.info(`MX        using the requested apex ${domain}`);
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
    const candidates = [target.emailDomain];
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
    log.info(`Updating ${renewal} with a scoped credential; the platform will reconcile setup.`);
  } else {
    await decideTarget();
  }

  // Token creation needs a browser or a masked paste prompt.
  const interactive = deps.isInteractive ?? !isWranglerNonInteractiveOrCI();
  if (!interactive) {
    return fail(
      'email: `void email domain add` needs an interactive terminal to create or paste a scoped Cloudflare API token. Run it locally.',
    );
  }

  let credential: EmailDomainCredential;
  {
    log.info(
      `Create a Cloudflare API token restricted to the account and DNS zone containing ${target.emailDomain}. In the resource selectors, replace All accounts and All zones with those exact resources. Workers Scripts Write still applies to every Worker in the selected account.`,
    );
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

  const scopeConfirmed = await (
    deps.confirmScope ??
    (async (domain: string) => {
      const answer = await confirm({
        message: `Is this token restricted to the Cloudflare account and DNS zone containing ${domain}?`,
        initialValue: false,
      });
      return !isCancel(answer) && answer === true;
    })
  )(target.emailDomain);
  if (!scopeConfirmed) {
    return fail(
      'email: restrict the token to the selected account and zone before adding the domain. Nothing was submitted to the platform.',
    );
  }

  const attemptId = crypto.randomUUID();
  log.info(`Setup operation: ${attemptId}`);
  let row: EmailDomainResponse;
  try {
    row = await client.addEmailDomain(projectId, {
      domain: target.emailDomain,
      apiToken: credential.apiToken,
      attemptId,
    });
  } catch (error) {
    if (error instanceof PlatformApiError && [400, 403, 404, 409].includes(error.status)) {
      throw error;
    }
    const sleep =
      deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; attempt < ADD_RECONCILE_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await sleep(ADD_RECONCILE_INTERVAL_MS);
      }
      let operation;
      try {
        operation = await client.getEmailOperation(projectId, attemptId);
      } catch {
        continue;
      }
      note(
        [
          `Operation:   ${operation.operationId}`,
          `Status:      ${operation.status}`,
          `Inbound:     ${operation.readiness.inbound.status}`,
          `Outbound:    ${operation.readiness.outbound.status}`,
          `Credential:  ${operation.readiness.management.status}`,
        ].join('\n'),
        'Email Setup',
      );
      if (operation.error) {
        log.error(operation.error);
      }
      log.info(`Run \`void email domain status ${target.emailDomain}\` to inspect setup.`);
      if (operation.status === 'completed') {
        return;
      }
      return fail(
        `email: setup is ${operation.status}; operation ${operation.operationId} retains its confirmed progress on the platform.`,
      );
    }
    return fail(
      `email: setup outcome is unknown (operation ${attemptId}). Nothing was revoked. Check \`void email domain status ${target.emailDomain}\` before starting another setup.`,
    );
  }
  log.success(
    'Token stored encrypted on the platform for this zone connection — nothing is kept on this machine.',
  );
  printEmailDomainOutcome(row);
  if (row.operationStatus !== 'completed') {
    return exit(1);
  }
}

function emailDomainStatusText(status: EmailDomainResponse['status']): string {
  if (status === 'ready') {
    return pc.green('ready');
  }
  if (status === 'pending') {
    return pc.yellow('pending');
  }
  return status === 'disabled' ? pc.yellow('disabled') : pc.red(status);
}

function printEmailDomainOutcome(row: EmailDomainResponse, projectRef?: string): void {
  const lines = [
    `Domain:      ${row.domain}`,
    `Managed by:  ${row.managed_by === 'admin' ? 'administrator' : 'project owner'}`,
    ...Object.entries(row.readiness).map(
      ([name, value]) =>
        `${name.padEnd(12)} ${value.status}${value.reason ? ' — ' + value.reason : ''}${value.observedAt ? ' (' + value.observedAt + ')' : ''}`,
    ),
  ];
  if (row.operationId) {
    lines.push(
      `Operation:   ${row.operationId}${row.operationStatus ? ' · ' + row.operationStatus : ''}`,
    );
  }
  note(lines.join('\n'), 'Email Domain');
  if (row.error) {
    log.error(row.error);
  }
  if (row.operationStatus === 'unknown') {
    log.warn(
      `Operation ${row.operationId} has an unknown outcome; inspect its status before retrying.`,
    );
    return;
  }
  if (
    row.readiness.management.status === 'expired' ||
    row.readiness.management.status === 'revoked'
  ) {
    log.info(
      row.managed_by === 'admin'
        ? `Ask your administrator to run \`void platform email domain-add ${row.domain} --project ${projectRef ?? row.projectId}\` with a renewed credential.`
        : `Run \`void email domain add ${row.domain}\` with a new scoped API token.`,
    );
  } else if (
    row.readiness.inbound.status === 'pending' ||
    row.readiness.inbound.status === 'drifted'
  ) {
    log.info(
      row.managed_by === 'admin'
        ? `Ask your administrator to run \`void platform email domain-sync ${row.domain}\` to reconcile setup.`
        : `Run \`void email domain sync ${row.domain}\` to reconcile setup.`,
    );
  }
}

export async function emailDomainStatus(
  client: Pick<PlatformClient, 'getEmailDomain' | 'getEmailSettings'>,
  projectId: string,
  rawDomain: string,
): Promise<void> {
  const domain = normalizeEmailDomainInput(rawDomain);
  const row = await client.getEmailDomain(projectId, domain);
  const projectRef =
    row.managed_by === 'admin'
      ? ((await client.getEmailSettings(projectId)).domains.projectSlug ?? projectId)
      : undefined;
  printEmailDomainOutcome(row, projectRef);
}

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
      `  ${row.domain.padEnd(width)}  ${emailDomainStatusText(row.status)}  ${row.managed_by === 'admin' ? 'administrator' : 'project owner'}`,
  );
  note(lines.join('\n'), 'Email Domains');
}

export async function emailDomainSync(
  client: Pick<PlatformClient, 'syncEmailDomain'>,
  projectId: string,
  rawDomain: string,
): Promise<void> {
  const domain = normalizeEmailDomainInput(rawDomain);
  const row = await client.syncEmailDomain(projectId, domain);
  printEmailDomainOutcome(row);
  if (row.operationStatus !== 'completed') {
    throw new Error(
      `email: reconciliation ${row.operationStatus ?? 'pending'}; inspect operation ${row.operationId ?? row.domain}`,
    );
  }
}

/** Rotation applies to every domain sharing this zone connection. */
export async function emailDomainRotateSecret(
  client: Pick<PlatformClient, 'rotateEmailDomainSecret' | 'getEmailOperation'>,
  projectId: string,
  rawDomain: string,
  deps: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const domain = normalizeEmailDomainInput(rawDomain);
  const attemptId = crypto.randomUUID();
  let row: EmailDomainResponse;
  try {
    row = await client.rotateEmailDomainSecret(projectId, domain, attemptId);
  } catch (error) {
    if (error instanceof PlatformApiError && [400, 403, 404, 409].includes(error.status)) {
      throw error;
    }
    const sleep =
      deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; attempt < ADD_RECONCILE_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await sleep(ADD_RECONCILE_INTERVAL_MS);
      }
      let operation;
      try {
        operation = await client.getEmailOperation(projectId, attemptId);
      } catch {
        continue;
      }
      note(
        [
          `Operation:   ${operation.operationId}`,
          `Status:      ${operation.status}`,
          `Inbound:     ${operation.readiness.inbound.status}`,
          `Outbound:    ${operation.readiness.outbound.status}`,
          `Credential:  ${operation.readiness.management.status}`,
        ].join('\n'),
        'Email Secret Rotation',
      );
      if (operation.status !== 'completed') {
        throw new Error(
          `email: secret rotation ${operation.status}; inspect operation ${operation.operationId}`,
        );
      }
      log.success('Zone ingress secret rotated and verified on the deployed Worker.');
      return;
    }
    throw new Error(
      `email: secret rotation outcome is unknown (operation key ${attemptId}); inspect \`void email domain status ${domain}\` before starting another rotation.`,
    );
  }
  printEmailDomainOutcome(row);
  if (row.operationStatus !== 'completed') {
    throw new Error(
      `email: secret rotation ${row.operationStatus ?? 'pending'}; inspect operation ${row.operationId ?? row.domain}`,
    );
  }
  log.success('Zone ingress secret rotated and verified on the deployed Worker.');
}

export async function emailDomainRemove(
  client: Pick<PlatformClient, 'removeEmailDomain'>,
  projectId: string,
  rawDomain: string,
  options: { exit?: (code: number) => never } = {},
): Promise<void> {
  const domain = normalizeEmailDomainInput(rawDomain);
  const result = await client.removeEmailDomain(projectId, domain);
  log.info(`Operation: ${result.operationId} · ${result.operationStatus ?? 'pending'}`);
  if (!result.removed || result.operationStatus !== 'completed') {
    log.error(
      result.error ??
        'Email cleanup is not complete. Its operation and resources remain recorded for reconciliation.',
    );
    (options.exit ?? ((code: number): never => process.exit(code)))(1);
    return;
  }
  log.success(`Removed ${domain}. Zone resources still used by other domains were retained.`);
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
    case 'rotate-secret':
      return emailDomainRotateSecret(client, projectId, args.domain!);
    case 'remove':
      return emailDomainRemove(client, projectId, args.domain!);
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

interface EmailWranglerConfigContext {
  path: string;
  cleanup: () => void;
}

/**
 * Wrangler discovers config files by walking parent directories. A standalone email command in
 * an app with no root config must still run in an explicit empty config context, otherwise an
 * unrelated ancestor config can select the wrong account. The real project path remains separate:
 * setup writes there only after it succeeds, while status leaves the project untouched.
 */
function createEmailWranglerConfigContext(configPath: string): EmailWranglerConfigContext {
  if (existsSync(configPath)) {
    return { path: configPath, cleanup: () => {} };
  }

  const directory = mkdtempSync(join(tmpdir(), 'void-email-wrangler-'));
  const path = join(directory, 'wrangler.jsonc');
  try {
    writeFileSync(path, '{}\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    path,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
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
  const rawExit = deps.exit ?? ((code: number): never => process.exit(code));
  // Keep project validation ahead of Cloudflare-config discovery, including its legacy-TOML
  // refusal. No config context is needed until the command is ready to make account reads.
  const voidConfig = readConfig(root);
  const from = voidConfig.email?.from;
  if (!from) {
    log.error(
      'email: no sender configured. Set email.from to "you@mail.acme.com" in void.config.ts — its host is the domain email is set up on.',
    );
    return rawExit(1);
  }
  const paths = readProjectPaths(root);
  const handlers = scanEmailHandlersSync(paths.sourceRoot);

  const configPath = discoverRootWranglerConfig(root);
  const wranglerConfig = createEmailWranglerConfigContext(configPath);
  try {
    return await runEmailCloudflareCommandInConfig(
      root,
      args,
      { from, handlers },
      configPath,
      wranglerConfig.path,
      {
        ...deps,
        exit: (code: number): never => {
          wranglerConfig.cleanup();
          return rawExit(code);
        },
      },
    );
  } finally {
    wranglerConfig.cleanup();
  }
}

async function runEmailCloudflareCommandInConfig(
  root: string,
  args: EmailArgs,
  project: {
    from: string;
    handlers: ReturnType<typeof scanEmailHandlersSync>;
  },
  configPath: string,
  wranglerConfigPath: string,
  deps: EmailCloudflareCommandDeps,
): Promise<void> {
  const exit = deps.exit ?? ((code: number): never => process.exit(code));
  const print = deps.print ?? ((block: string): void => log.message(block));
  const fail = (message: string): never => {
    log.error(message);
    return exit(1);
  };

  // 1. Inputs from the local project: `email.from` is the ONLY domain input (decision 9).
  const { from, handlers } = project;

  // 2. The same pinned transport + account + worker name as `void deploy --platform
  //    cloudflare`, so every wrangler child here consults the account the deploy will.
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
        'Set `cloudflare.account_id` in void.config.ts, or export CLOUDFLARE_ACCOUNT_ID —',
        'the same pin `void deploy --platform cloudflare` needs.',
      ].join('\n'),
    );
  }
  const workerName = readWranglerTopLevelString(rootConfig, 'name') ?? deriveWorkerName(root);
  const runWrangler = deps.runWrangler ?? createDeployWranglerRunner(root, accountId, apiBaseUrl);
  // The same bearer bridge the deploy's step 3b-ii uses: `wrangler auth token --json` on the
  // pinned runner, WRANGLER_WRITE_LOGS=false so the token never reaches wrangler's on-disk log.
  const getSessionBearer =
    deps.getSessionBearer ?? (() => runWranglerAuthToken(runWrangler, wranglerConfigPath));
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
    configPath: wranglerConfigPath,
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
        'email: `void email setup` changes your Cloudflare account, so it needs an interactive terminal. Run it locally once, commit void.lock.json, then redeploy.',
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
