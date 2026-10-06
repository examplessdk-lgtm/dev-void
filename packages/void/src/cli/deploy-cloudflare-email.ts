import { basename } from 'pathslash';
import { runWranglerAuthToken } from './deploy-cloudflare-auth.ts';
import { log, getErrorMessage } from './deploy-helpers.ts';
import {
  type CloudflareEmailStepInput,
  type CloudflareEmailStepResult,
  type EmailAddressMapInput,
} from './deploy-types.ts';
import {
  applyEmailSetup,
  EMAIL_FROM_VAR,
  findEmailConfigConflicts,
  preflightEmail,
  SEND_EMAIL_BINDING,
  renderEmailChecklist,
  type EmailCloudflareInputs,
  type EmailPreflight,
} from './email-cloudflare.ts';
import { writeProvisionedWranglerConfig, type ProvisionedWranglerPatch } from './wrangler.ts';

/** Whether the root config carries the `send_email` binding Void writes. */
export function hasVoidSendEmailBinding(rootConfig: Record<string, unknown>): boolean {
  return (
    Array.isArray(rootConfig.send_email) &&
    (rootConfig.send_email as Array<{ name?: unknown } | null>).some(
      (binding) => binding?.name === SEND_EMAIL_BINDING,
    )
  );
}

/**
 * Immediately after setup, the local resolver can retain ENODATA while Cloudflare's public DNS
 * already serves the new subdomain MX. When the committed config is exactly setup's plan and
 * every other inbound prerequisite is still ready, DNS is ambiguous: deleting `addresses`
 * destroys the handoff, while deploying it could fail after upload if routing is genuinely off.
 */
function isCommittedSubdomainPlanWaitingForDns(
  pre: EmailPreflight,
  rootConfig: Record<string, unknown>,
): boolean {
  if (
    pre.mode !== 'subdomain' ||
    (pre.domainMx.state !== 'empty' && pre.domainMx.state !== 'unknown') ||
    pre.routing.enabled !== true ||
    pre.subaddressing.state !== 'on' ||
    pre.binding.state !== 'present' ||
    pre.sender.state !== 'ready' ||
    pre.addressesOwnership.state !== 'mine' ||
    pre.addressesStale ||
    pre.rules.state === 'unknown' ||
    pre.rules.foreign.length > 0 ||
    !Array.isArray(rootConfig.addresses) ||
    rootConfig.addresses.length === 0
  ) {
    return false;
  }

  const allBlockers = pre.blockers.filter((blocker) => blocker.scope === 'all');
  if (pre.domainMx.state === 'empty') {
    return allBlockers.length === 0;
  }
  // `preflightEmail` always adds one all-scope blocker for an unknown domain MX. Exactly one
  // therefore means DNS is the only such blocker, without coupling this gate to rendered prose.
  return allBlockers.length === 1;
}

/**
 * Step 3b-ii — Mode B email on the developer's own account (design doc 0078, "One keystroke").
 * Preflight is read-only; the checklist is shown; ONE `confirm` (default Yes) authorizes the
 * apply, which runs only the rows not ready and returns the root-config patch this writes.
 * Most branches that cannot finish return `satisfied: false`, leaving `--require-email` to
 * decide whether deployment continues. One ambiguous handoff fails closed for every deploy:
 * an exact committed subdomain plan whose new MX is still empty or unreadable. It is preserved,
 * and the caller stops before build/upload until DNS can be verified. No output of this step
 * ever contains the session bearer: the module borrows it through `getSessionBearer` inside its
 * own closures and drops it.
 */
export async function runCloudflareEmailStep(
  input: CloudflareEmailStepInput,
): Promise<CloudflareEmailStepResult> {
  const without: CloudflareEmailStepResult = { satisfied: false, configWritten: false, map: null };
  const from = input.voidConfig.email?.from;
  if (!from) {
    const carriesEmailConfig =
      hasVoidSendEmailBinding(input.rootConfig) ||
      (Array.isArray(input.rootConfig.addresses) && input.rootConfig.addresses.length > 0);
    if (carriesEmailConfig) {
      log.info(
        'deploy: email.from is unset; skipping automatic email setup. Existing Cloudflare email configuration is preserved.',
      );
    } else {
      log.warn(
        [
          'deploy: this app uses email, but void.config.ts names no sender.',
          'Set email.from to "you@mail.acme.com" in void.config.ts — automatic email setup skipped.',
        ].join('\n'),
      );
    }
    return without;
  }
  const { rootConfig } = input;
  const configName = basename(input.configPath);
  const inputs: EmailCloudflareInputs = {
    handlers: input.handlers,
    from,
    workerName: input.workerName,
    accountId: input.accountId,
    existingSendEmail: Array.isArray(rootConfig.send_email)
      ? (rootConfig.send_email as Array<{ name?: unknown }>)
      : undefined,
    existingAddresses: rootConfig.addresses,
    existingVars:
      rootConfig.vars && typeof rootConfig.vars === 'object' && !Array.isArray(rootConfig.vars)
        ? (rootConfig.vars as Record<string, unknown>)
        : undefined,
    configConflicts: findEmailConfigConflicts(rootConfig),
    // The SAME `-c`/`--env=` context every other credentialed wrangler run gets.
    configPath: input.configPath,
    apiBaseUrl: input.apiBaseUrl,
    runWrangler: input.runWrangler,
    getSessionBearer: () => runWranglerAuthToken(input.runWrangler, input.configPath),
    fetchImpl: input.fetchImpl,
    dns: input.dns,
  };

  let pre: EmailPreflight;
  try {
    pre = await preflightEmail(inputs);
  } catch (err) {
    log.warn(`deploy: email preflight failed — ${getErrorMessage(err)}. Deploying without email.`);
    return without;
  }
  const mapFor = (
    addresses: Array<string>,
    sendingReady: boolean,
    creating: Array<string> = [],
  ): EmailAddressMapInput => ({
    from,
    routes: pre.derived.routes,
    addresses,
    sendingReady,
    creating,
  });
  // Pin `configPath` so read/parse/write hit the SAME file every other step uses. A refused
  // write (e.g. an `addresses` array with a comment nested inside it) is the developer's
  // territory (decision 13): surface it as-is; the caller decides what the deploy ships.
  const writeConfig = (patch: ProvisionedWranglerPatch): boolean => {
    try {
      writeProvisionedWranglerConfig(input.root, patch, { configPath: input.configPath });
      return true;
    } catch (err) {
      log.error(`deploy: could not update ${configName} — ${getErrorMessage(err)}.`);
      return false;
    }
  };

  // Every account row ready: no prompt, no account call, zero keystrokes (the second deploy).
  // A sending row the committed binding remembers as refused (Workers Free) lands here too
  // — the deploy never retries the onboarding; the map ends `(verified destinations only)`
  // and `void email setup` is where the retry is offered (`preflightEmail`'s memory rule).
  // The two CONFIG rows are reconciled here by a plain file write, because a stale one is
  // not idle: an `addresses` entry no longer in the pruned set reaches wrangler's plan as a
  // `conflict` (a takeover prompt in a TTY, a UserError after the upload in CI — decision
  // 12), and a stale `__VOID_EMAIL_FROM` ships the OLD sender while the map prints the new.
  //
  // The `null` (key removed) branch below is reachable in exactly one shape: every derived
  // address is routed elsewhere (a forward, another worker — a worker rename makes all of
  // them so), so this worker OWNS none of those rules and `[]` would plan nothing either;
  // the key goes because a plan on a stale entry is a `conflict`. A handler deleted while
  // its entry stays never gets here: the preflight (step 8) has no provenance for entries
  // Void wrote on an earlier deploy, so it reads that leftover as an entry Void did not
  // derive — the decision-13 blocker, array untouched, rule still routed to this worker
  // (guide: "Deleting a handler leaves its address in `addresses`"). Making the leftover
  // Void-managed instead (a marker like `void:managed-queues`, then `[]` or a prune) is
  // decision 13's other branch, and under `triggers deploy` a `[]` plan that deletes owned
  // rules is destructive: wrangler asks (default No) in a TTY and throws in CI, which the
  // activation reports as `triggers-failed` and compensates by restoring the previous
  // version. A product call, not a deploy default.
  if (pre.ready) {
    const patch: ProvisionedWranglerPatch = {};
    const rows: Array<string> = [];
    if (pre.addressesStale) {
      patch.addresses = pre.addresses.length > 0 ? pre.addresses : null;
      rows.push(
        pre.addresses.length > 0
          ? `addresses: ${JSON.stringify(pre.addresses)}`
          : 'addresses removed',
      );
    }
    if (pre.sender.state !== 'ready') {
      patch.vars = { [EMAIL_FROM_VAR]: from };
      rows.push(`vars.${EMAIL_FROM_VAR}: ${JSON.stringify(from)}`);
    }
    let configWritten = false;
    if (rows.length > 0) {
      // The prune rows the checklist would have carried: say why an entry goes.
      for (const foreign of pre.addressesStale ? pre.rules.foreign : []) {
        log.message(
          `    ! ${foreign.address}: already routed to ${foreign.owner}; left alone, not in addresses`,
        );
      }
      if (!writeConfig(patch)) {
        log.warn(`deploy: deploying with the email setup ${configName} already carries.`);
        return {
          ...without,
          map: mapFor(existingAddresses(rootConfig, pre), pre.sending.state === 'ready'),
        };
      }
      configWritten = true;
      log.message(`  ✔ config    ${configName} updated (${rows.join(', ')})`);
    }
    return {
      satisfied: true,
      configWritten,
      map: mapFor(pre.addresses, pre.sending.state === 'ready', pre.rulesPending),
    };
  }

  // The checklist carries the `✘` rows, so a blocked run explains itself before the warn line.
  log.message(renderEmailChecklist(pre));
  if (isCommittedSubdomainPlanWaitingForDns(pre, rootConfig)) {
    const dnsState =
      pre.domainMx.state === 'empty'
        ? 'this resolver sees no MX records yet'
        : 'the MX lookup failed';
    log.error(
      [
        `deploy: cannot verify Email Routing on ${pre.domain} because ${dnsState}.`,
        `The existing addresses plan in ${configName} is preserved. DNS may still be propagating after \`void email setup\`; run \`void email status --platform cloudflare\` and retry the deploy when this resolver sees Cloudflare's MX records.`,
        'Nothing was built or uploaded.',
      ].join('\n'),
    );
    return {
      ...without,
      abortDeploy: true,
      map: mapFor(existingAddresses(rootConfig, pre), pre.sending.state === 'ready'),
    };
  }
  // The three exits below leave the account alone. What the worker then ships is whatever
  // the config already carries — so when the binding is committed the deploy is WITH the
  // existing setup (map printed, wording says so). A committed `addresses` array whose routing
  // is verifiably off is withdrawn first: wrangler's plan on it 400s (`2062`) AFTER the upload,
  // on every deploy, until the key goes (0078: "deleted, never `[]`, when a later preflight finds
  // routing off"). The ambiguous post-setup DNS case returned above instead. Only Void's own
  // array is touched (decision 13); deleting the KEY changes no rule — wrangler skips the plan.
  const shipsBinding = pre.binding.state === 'present';
  const leaveAccount = (reason: string): CloudflareEmailStepResult => {
    let configWritten = false;
    if (
      Array.isArray(rootConfig.addresses) &&
      pre.addressesOwnership.state === 'mine' &&
      pre.routing.state !== 'ready'
    ) {
      // A refused write leaves the array where it is; the deploy goes on as it would have.
      if (writeConfig({ addresses: null })) {
        configWritten = true;
        log.message(
          `  ! config    addresses removed from ${configName} (routing on ${pre.domain} is ${pre.routing.state}); no routing rule is created for ${(rootConfig.addresses as Array<unknown>).map(String).join(', ')}`,
        );
      }
    }
    log.warn(
      `deploy: ${reason} — ${shipsBinding ? `deploying with the email setup ${configName} already carries.` : 'deploying without email.'}`,
    );
    return {
      satisfied: false,
      configWritten,
      map: shipsBinding
        ? mapFor(
            configWritten ? [] : existingAddresses(rootConfig, pre),
            pre.sending.state === 'ready',
          )
        : null,
    };
  };
  if (pre.blockers.some((b) => b.scope === 'all')) {
    return leaveAccount(`email on ${pre.domain} cannot be set up from here.`);
  }
  if (input.nonInteractive) {
    return leaveAccount(
      [
        `email on ${pre.domain} is not ${shipsBinding ? 'fully ' : ''}set up, and this shell cannot ask.`,
        'Run `void email setup --platform cloudflare` once locally, commit void.lock.json, then redeploy.',
      ].join('\n'),
    );
  }
  if (!(await input.confirm(`Set up email on ${pre.domain}?`))) {
    return leaveAccount(
      'email setup skipped — run `void email setup --platform cloudflare` later.',
    );
  }

  const out = await applyEmailSetup(pre, inputs);
  if (out.lines.length > 0) {
    log.message(out.lines.join('\n'));
  }
  let configWritten = false;
  if (
    out.patch.sendEmail !== undefined ||
    out.patch.addresses !== undefined ||
    out.patch.vars !== undefined
  ) {
    if (
      !writeConfig({
        sendEmail: out.patch.sendEmail,
        addresses: out.patch.addresses,
        vars: out.patch.vars,
      })
    ) {
      log.warn('deploy: deploying without email.');
      return without;
    }
    configWritten = true;
  }
  const bindingPresent = shipsBinding || out.patch.sendEmail !== undefined;
  const written = out.patch.addresses ?? [];
  // `satisfied` is post-apply READINESS, not binding presence. `applyEmailSetup` writes
  // `patch.sendEmail` as soon as EITHER routing or sending came up, and withholds
  // `addresses` when the bearer failed or routing is off — so a run whose subdomain
  // routing POST failed ships the binding with no inbound rule behind it, which is
  // exactly the end state the `leaveAccount` branch above already returns as
  // `satisfied: false`. Gating `--require-email` on the binding alone would contradict
  // both that branch and the error text ("not fully set up … refusing to deploy"), so
  // this mirrors `preflightEmail`'s own `ready` predicate instead: the inbound rows
  // (routing + subaddressing, with `addresses` actually written — `out.inboundReady`, the
  // same field `void email setup` exits on) + the binding. The sending row needs no term
  // of its own: apply has just made its one `sending enable` call (or found the row ready
  // or blocked), and the binding it writes on that same run is what the NEXT preflight
  // reads as the memory of a refusal — binding present + sending pending is settled there
  // (Workers Free, `10105`; the memory rule in `preflightEmail`), so it is settled here,
  // or the two would disagree on the very next deploy. `map` stays on `bindingPresent`:
  // the worker DOES ship with email, and a deploy may ship with email while `satisfied`
  // is false.
  const satisfied = bindingPresent && out.inboundReady;
  return {
    satisfied,
    configWritten,
    map: bindingPresent
      ? mapFor(
          written,
          out.sendingReady,
          pre.rules.absent.filter((a) => written.includes(a)),
        )
      : null,
  };
}

/** The committed `addresses` entries that are still Void's pruned set (what wrangler keeps). */
function existingAddresses(
  rootConfig: Record<string, unknown>,
  pre: EmailPreflight,
): Array<string> {
  return Array.isArray(rootConfig.addresses)
    ? (rootConfig.addresses as Array<unknown>)
        .map((a) => (typeof a === 'string' ? a.toLowerCase() : ''))
        .filter((a) => pre.addresses.includes(a))
    : [];
}
