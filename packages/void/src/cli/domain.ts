import { log, note } from '@clack/prompts';
import { getToken } from './auth.ts';
import { PlatformClient } from './client.ts';
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
      return domainStatus(client, projectId!, args.hostname!);
  }
}

async function domainAdd(
  client: PlatformClient,
  projectId: string,
  hostname: string,
): Promise<void> {
  const domain = await client.addDomain(projectId, hostname);
  log.success(`Domain ${hostname} added (status: ${domain.status})`);

  const sections: Array<string> = [];

  if (domain.cname_target) {
    sections.push(`CNAME (traffic)\n    ${hostname} → ${domain.cname_target}`);
  }

  if (domain.ownership_verification) {
    sections.push(
      `TXT (ownership verification)\n    ${domain.ownership_verification.name} → ${domain.ownership_verification.value}`,
    );
  }

  const sslRecords = (domain.ssl_validation_records ?? []).filter(
    (r): r is { txt_name: string; txt_value: string; status?: string } =>
      Boolean(r.txt_name) && Boolean(r.txt_value),
  );
  if (sslRecords.length > 0) {
    const lines = sslRecords.map((r) => `    ${r.txt_name} → ${r.txt_value}`).join('\n');
    sections.push(`TXT (SSL validation)\n${lines}`);
  }

  if (sections.length > 0) {
    note(sections.join('\n\n'), 'DNS Setup');
  }

  log.info('Run `void domain status ' + hostname + '` to check verification progress.');
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

async function domainStatus(
  client: PlatformClient,
  projectId: string,
  hostname: string,
): Promise<void> {
  const domains = await client.listDomains(projectId);
  const domain = domains.find((d) => d.hostname === hostname);
  if (!domain) {
    log.error(`domain: Domain '${hostname}' not found on this project.`);
    process.exit(1);
  }

  const status = await client.getDomainStatus(projectId, domain.id);
  const lines = [
    `Hostname:    ${status.hostname}`,
    `Status:      ${status.status}`,
    `SSL Status:  ${status.ssl_status}`,
  ];
  if (status.ownership_verification) {
    lines.push(`Ownership:   pending`);
  }
  if (status.verification_errors && status.verification_errors.length > 0) {
    lines.push(`Errors:      ${status.verification_errors.join(', ')}`);
  }
  note(lines.join('\n'), 'Domain Status');

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
      const sslRecords = (status.ssl_validation_records ?? []).filter(
        (r): r is { txt_name: string; txt_value: string; status?: string } =>
          Boolean(r.txt_name) && Boolean(r.txt_value),
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
