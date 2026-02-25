import { log, note } from "@clack/prompts";

import { getToken } from "./auth";
import { PlatformClient } from "./client";
import { pc } from "./output";
import { readProjectConfig } from "./project";

export interface DomainArgs {
  subcommand: "add" | "remove" | "list" | "status";
  hostname?: string;
  projectSlug?: string;
}

export function parseDomainArgs(args: string[]): DomainArgs {
  const subcommand = args[0] as DomainArgs["subcommand"];
  if (!subcommand || !["add", "remove", "list", "status"].includes(subcommand)) {
    throw new Error("Usage: void domain <add|remove|list|status> [hostname] [--project <name>]");
  }

  let hostname: string | undefined;
  let projectSlug: string | undefined;

  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--project" && rest[i + 1]) {
      projectSlug = rest[++i];
    } else if (!hostname) {
      hostname = rest[i];
    }
  }

  if ((subcommand === "add" || subcommand === "remove" || subcommand === "status") && !hostname) {
    throw new Error(`Usage: void domain ${subcommand} <hostname> [--project <name>]`);
  }

  return { subcommand, hostname, projectSlug };
}

export async function runDomainCommand(root: string, args: DomainArgs): Promise<void> {
  const token = getToken();
  if (!token) {
    log.error("Not logged in. Run `void login` first.");
    process.exit(1);
  }

  const client = new PlatformClient(token);

  // Resolve project
  const requestedSlug = args.projectSlug ?? process.env.VOID_PROJECT?.trim();
  let projectId: string | undefined;

  if (requestedSlug) {
    const projects = await client.listProjects();
    const project = projects.find((p) => p.slug === requestedSlug);
    if (!project) {
      log.error(`No project found with slug "${requestedSlug}".`);
      process.exit(1);
    }
    projectId = project.id;
  } else {
    const config = readProjectConfig(root);
    if (!config) {
      log.error("No linked project. Run `void link` or pass --project <name>.");
      process.exit(1);
    }
    projectId = config.projectId;
  }

  switch (args.subcommand) {
    case "add":
      return domainAdd(client, projectId!, args.hostname!);
    case "remove":
      return domainRemove(client, projectId!, args.hostname!);
    case "list":
      return domainList(client, projectId!);
    case "status":
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
  note(`Add a CNAME record:\n  ${hostname} → ${domain.cname_target}`, "DNS Setup");
  log.info("Run `void domain status " + hostname + "` to check verification progress.");
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
    log.error(`Domain "${hostname}" not found on this project.`);
    process.exit(1);
  }

  await client.removeDomain(projectId, domain.id);
  log.success(`Domain ${hostname} removed.`);
}

async function domainList(client: PlatformClient, projectId: string): Promise<void> {
  const domains = await client.listDomains(projectId);
  if (domains.length === 0) {
    log.info("No custom domains configured.");
    return;
  }

  const lines = domains.map((d) => {
    const status = d.status === "active" ? pc.green("active") : pc.yellow(d.status);
    return `  ${d.hostname}  ${status}`;
  });
  note(lines.join("\n"), "Custom Domains");
}

async function domainStatus(
  client: PlatformClient,
  projectId: string,
  hostname: string,
): Promise<void> {
  const domains = await client.listDomains(projectId);
  const domain = domains.find((d) => d.hostname === hostname);
  if (!domain) {
    log.error(`Domain "${hostname}" not found on this project.`);
    process.exit(1);
  }

  const status = await client.getDomainStatus(projectId, domain.id);
  const lines = [
    `Hostname:    ${status.hostname}`,
    `Status:      ${status.status}`,
    `SSL Status:  ${status.ssl_status}`,
  ];
  if (status.verification_errors && status.verification_errors.length > 0) {
    lines.push(`Errors:      ${status.verification_errors.join(", ")}`);
  }
  note(lines.join("\n"), "Domain Status");
}
