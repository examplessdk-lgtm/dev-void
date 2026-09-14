import { confirm, isCancel, log, note } from '@clack/prompts';
import { parseRootWranglerConfig, readWranglerTopLevelString } from '@void/deploy-cloudflare';
import { readConfig } from '../config.ts';
import { readProjectPaths } from '../project-paths.ts';
import { scanEmailHandlersSync } from '../router/email.ts';
import { getToken } from './auth.ts';
import { PlatformClient } from './client.ts';
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
import { pc } from './output.ts';
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

async function emailDisallow(
  client: PlatformClient,
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
  log.success(`Removed ${dest.address}. Outbound to this address will be rejected on next deploy.`);
}

async function emailLogs(client: PlatformClient, projectId: string, limit?: number): Promise<void> {
  // The API currently ignores `limit`; server-side wiring is pending the
  // Analytics Engine integration. Forwarding it now keeps the CLI
  // forward-compatible — once persistent storage lands, no client change is
  // needed.
  const result = await client.getEmailLogs(projectId, limit);
  if (result.pending) {
    log.info(result.note ?? 'Persistent log storage is not yet wired up.');
    log.info('Real-time activity is visible in `wrangler tail` output for the proxy worker.');
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
      'Routing rules are created by the next `void deploy --platform cloudflare` (wrangler applies the Email Routing plan on deploy).',
    );
  }
  log.success(`Email set up on ${pre.domain}.`);
}
