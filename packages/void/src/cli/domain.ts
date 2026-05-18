import { log, note } from '@clack/prompts';
import { getToken } from './auth.ts';
import { type DomainStatusResponse, PlatformClient } from './client.ts';
import type { DomainArgs } from './domain-args.ts';
import { pc } from './output.ts';
import { readProjectConfig } from './project.ts';

export async function runDomainCommand(root: string, args: DomainArgs): Promise<void> {
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
    case 'add':
      return domainAdd(client, projectId!, args.hostname!);
    case 'delete':
      return domainRemove(client, projectId!, args.hostname!);
    case 'list':
      return domainList(client, projectId!);
    case 'status':
      return domainStatus(client, projectId!, args.hostname!, args.verbose === true);
  }
}

async function domainAdd(
  client: PlatformClient,
  projectId: string,
  hostname: string,
): Promise<void> {
  const domain = await client.addDomain(projectId, hostname);
  log.success(`Domain ${hostname} added (status: ${domain.status})`);

  // Named locals make the section order explicit (CNAME -> ownership -> SSL),
  // rather than relying on the order of conditional pushes onto an array.
  let cnameSection: string | undefined;
  let ownershipSection: string | undefined;
  let sslSection: string | undefined;

  if (domain.cname_target) {
    cnameSection = `CNAME (traffic)\n    ${hostname} → ${domain.cname_target}`;
  }

  if (domain.ownership_verification) {
    ownershipSection = `TXT (ownership verification)\n    ${domain.ownership_verification.name} → ${domain.ownership_verification.value}`;
  }

  const sslRecords = (domain.ssl_validation_records ?? []).filter(
    (r): r is { txt_name: string; txt_value: string; status?: string } =>
      Boolean(r.txt_name) && Boolean(r.txt_value),
  );
  if (sslRecords.length > 0) {
    const lines = sslRecords.map((r) => `    ${r.txt_name} → ${r.txt_value}`).join('\n');
    sslSection = `TXT (SSL validation)\n${lines}`;
  } else {
    // Deadline-miss path: API short-poll didn't see SSL records before timeout.
    // Tell the user they'll surface in `domain status` instead of silently
    // omitting the section.
    sslSection = `SSL validation records will appear in \`void domain status\` shortly.`;
  }

  const summary = `Add the records above to your DNS, then run \`void domain status ${hostname}\` to check progress.`;

  const sections = [cnameSection, ownershipSection, sslSection, summary].filter(
    (s) => s !== undefined,
  );

  if (sections.length > 0) {
    note(sections.join('\n\n'), 'DNS Setup');
  }
}

async function domainRemove(
  client: PlatformClient,
  projectId: string,
  hostname: string,
): Promise<void> {
  // Find domain by hostname
  const domains = await client.listDomains(projectId);
  const domain = domains.find((d) => d.hostname === hostname);
  if (!domain) {
    log.error(`domain: Domain '${hostname}' not found on this project.`);
    process.exit(1);
  }

  await client.removeDomain(projectId, domain.id);
  log.success(`Domain ${hostname} removed.`);
}

async function domainList(client: PlatformClient, projectId: string): Promise<void> {
  const domains = await client.listDomains(projectId);
  if (domains.length === 0) {
    log.info('No custom domains configured.');
    return;
  }

  const lines = domains.map((d) => {
    const status = d.status === 'active' ? pc.green('active') : pc.yellow(d.status);
    return `  ${d.hostname}  ${status}`;
  });
  note(lines.join('\n'), 'Custom Domains');
}

export type RolledUpStatus = {
  state:
    | 'error'
    | 'awaiting_deployment'
    | 'awaiting_dns'
    | 'verifying_dns'
    | 'issuing_cert'
    | 'deploying_cert'
    | 'active'
    | 'pending';
  diagnostic: string;
};

export function computeRollup(status: DomainStatusResponse): RolledUpStatus {
  // Priority order matters: `error` and `awaiting_deployment` describe
  // user-actionable conditions that should override CF's state-machine view.
  if (status.verification_errors && status.verification_errors.length > 0) {
    return {
      state: 'error',
      diagnostic: `Verification failed: ${status.verification_errors[0]}`,
    };
  }

  if (status.awaiting_deployment === true) {
    return {
      state: 'awaiting_deployment',
      diagnostic:
        'Your project has no live deployment yet. Run `void deploy` to bring the domain online.',
    };
  }

  if (status.cf_status === 'pending' && status.ownership_verification) {
    return {
      state: 'awaiting_dns',
      diagnostic:
        'Cloudflare has not yet observed your _cf-custom-hostname TXT record. Confirm it is published at the host shown below.',
    };
  }

  if (status.cf_status === 'pending_validation') {
    return {
      state: 'verifying_dns',
      diagnostic: 'DNS records found, Cloudflare is validating ownership.',
    };
  }

  if (
    status.cf_status === 'pending_issuance' ||
    (status.cf_status === 'active' && status.ssl_status !== 'active')
  ) {
    return {
      state: 'issuing_cert',
      diagnostic: 'Cloudflare is issuing the SSL certificate (typically <5 minutes).',
    };
  }

  if (status.cf_status === 'pending_deployment') {
    return {
      state: 'deploying_cert',
      diagnostic: 'SSL certificate issued; Cloudflare is propagating it to its edge.',
    };
  }

  // `active` is keyed off the DB status, but only reached after the per-field
  // signals above have already surfaced cert-renewal / re-validation windows
  // (e.g. `issuing_cert` catches `cf_status === 'active' && ssl_status !== 'active'`
  // even when the DB row says active). Reaching this branch means CF and SSL
  // are both healthy.
  if (status.status === 'active') {
    return { state: 'active', diagnostic: 'Live.' };
  }

  return { state: 'pending', diagnostic: 'Verification pending. Cloudflare is processing.' };
}

async function domainStatus(
  client: PlatformClient,
  projectId: string,
  hostname: string,
  verbose: boolean,
): Promise<void> {
  const domains = await client.listDomains(projectId);
  const domain = domains.find((d) => d.hostname === hostname);
  if (!domain) {
    log.error(`domain: Domain '${hostname}' not found on this project.`);
    process.exit(1);
  }

  const status = await client.getDomainStatus(projectId, domain.id);
  const rollup = computeRollup(status);

  const rollupLines = [
    `Hostname: ${status.hostname}`,
    `Status:   ${rollup.state} — ${rollup.diagnostic}`,
  ];

  if (verbose) {
    // Visual separator: blank line + "Details:" header so the raw breakdown
    // reads as a distinct section under the rollup, not just a continuation.
    // `Hostname:` is already shown by the rollup above, so it's omitted here.
    rollupLines.push('', 'Details:');
    rollupLines.push(`  Status:      ${status.status}`);
    rollupLines.push(`  SSL Status:  ${status.ssl_status}`);
    if (status.ownership_verification) {
      rollupLines.push(`  Ownership:   pending`);
    }
    if (status.verification_errors && status.verification_errors.length > 0) {
      rollupLines.push(`  Errors:      ${status.verification_errors.join(', ')}`);
    }
  }

  note(rollupLines.join('\n'), 'Domain Status');

  // Gate on actual validation states, not the aggregate `status.status`.
  // Once the DB row is flipped to `active`, the API keeps returning
  // `status: 'active'` even if CF later reports SSL/ownership re-validation
  // (cert renewal, ownership re-check). Keying off the per-field states
  // ensures pending records still surface in that window. CF stops returning
  // `ownership_verification` once ownership is verified, so its presence is
  // itself the pending signal.
  const ownershipPending = Boolean(status.ownership_verification);
  const sslPending = status.ssl_status !== 'active';

  if (ownershipPending || sslPending) {
    const pendingSections: Array<string> = [];

    if (ownershipPending && status.ownership_verification) {
      pendingSections.push(
        `TXT (ownership verification)\n    ${status.ownership_verification.name} → ${status.ownership_verification.value}`,
      );
    }

    if (sslPending) {
      // Defensive: drop any per-record entries CF has already marked active.
      // CF normally clears `ssl.validation_records` once SSL is active, but
      // during cert renewals or partial states a stale `active` row can sit
      // alongside a pending one — we only want to surface what the user still
      // needs to add.
      const sslRecords = (status.ssl_validation_records ?? []).filter(
        (r): r is { txt_name: string; txt_value: string; status?: string } =>
          Boolean(r.txt_name) && Boolean(r.txt_value) && r.status !== 'active',
      );
      if (sslRecords.length > 0) {
        const lines = sslRecords.map((r) => `    ${r.txt_name} → ${r.txt_value}`).join('\n');
        pendingSections.push(`TXT (SSL validation)\n${lines}`);
      }
    }

    if (pendingSections.length > 0) {
      note(pendingSections.join('\n\n'), 'Add these DNS records to your provider');
    }
  }
}
