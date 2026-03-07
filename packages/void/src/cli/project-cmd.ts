import type { ProjectArgs } from "./project-args";
import { runProjectsCommand } from "./projects";

export async function runProjectCommand(root: string, args: ProjectArgs): Promise<void> {
  if (args.subcommand === "status") {
    const { runListCommand } = await import("./list");
    return runListCommand(root, args.name || undefined);
  }
  if (args.subcommand === "link") {
    const { runLink } = await import("./link");
    return runLink(root, args.name || undefined);
  }
  if (args.subcommand === "list") {
    return runProjectsCommand();
  }
  if (args.subcommand === "logs") {
    const { runLogsCommand } = await import("./logs");
    return runLogsCommand(root, args.filter, args.range, args.deployment || undefined);
  }
  if (args.subcommand === "rollback") {
    const { runRollbackCommand } = await import("./rollback");
    return runRollbackCommand(root, args.deployId || undefined);
  }
  if (args.subcommand === "delete") {
    const { runDeleteCommand } = await import("./delete");
    return runDeleteCommand(root, args.name || undefined, { force: args.force });
  }
}
