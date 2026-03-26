import type { SubcommandDef } from "./subcommand-prompt";

export const domainSubcommands: SubcommandDef[] = [
  { name: "add", arg: "<hostname>", description: "Add a custom domain" },
  { name: "delete", arg: "<hostname>", description: "Remove a custom domain" },
  { name: "list", description: "List custom domains + status" },
  { name: "status", arg: "<hostname>", description: "Check domain verification status" },
];

export interface DomainArgs {
  subcommand: "add" | "delete" | "list" | "status";
  hostname?: string;
  projectSlug?: string;
}

export function parseDomainArgs(args: string[]): DomainArgs {
  const subcommand = args[0] as DomainArgs["subcommand"];
  if (!subcommand || !["add", "delete", "list", "status"].includes(subcommand)) {
    throw new Error("Usage: void domain <add|delete|list|status> [hostname] [--project <name>]");
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

  if ((subcommand === "add" || subcommand === "delete" || subcommand === "status") && !hostname) {
    throw new Error(`Usage: void domain ${subcommand} <hostname> [--project <name>]`);
  }

  return { subcommand, hostname, projectSlug };
}
