import { log, note } from '@clack/prompts';
import { getToken } from './auth.ts';
import { PlatformClient } from './client.ts';
import type { EmailArgs } from './email-args.ts';
import { pc } from './output.ts';
import { readProjectConfig } from './project.ts';

export async function runEmailCommand(root: string, args: EmailArgs): Promise<void> {
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

async function emailAllow(
  client: PlatformClient,
  projectId: string,
  address: string,
): Promise<void> {
  const dest = await client.addEmailDestination(projectId, address);
  if (dest.status === 'verified') {
    log.success(`${dest.address} is already verified.`);
  } else {
    log.success(`Verification email sent to ${dest.address}.`);
    log.info(
      'They click the link in their inbox — no Void or Cloudflare account needed. `void email destinations` to poll status.',
    );
  }
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
