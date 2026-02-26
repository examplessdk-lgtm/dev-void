#!/usr/bin/env node

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { log, outro, note } from "@clack/prompts";
import { runLink } from "./link";
import { runLoginCommand } from "./login";
import { runProjectsCommand } from "./projects";
import { getToken, removeToken, isStagingMode, setStagingMode, printStagingBanner } from "./auth";
import { PlatformClient } from "./client";
import { parseDeployArgs } from "./args";
import { parseSecretArgs } from "./secret-args";
import { parseDbArgs } from "./db-args";
import { parseGenArgs } from "./gen-args";
import { parseDomainArgs } from "./domain";
import { categoryTitle, helpLine, pc, sectionTitle } from "./output";
import { getPackageDir } from "./agents";
import { asciiArts } from "./ascii";

const args = process.argv.slice(2);
const command = args[0];

printStagingBanner();

if (command === "staging") {
  const sub = args[1];
  if (sub === "on") {
    setStagingMode(true);
    log.success("Staging mode enabled.");
  } else if (sub === "off") {
    setStagingMode(false);
    log.success("Staging mode disabled.");
  } else {
    log.info(`Staging mode is ${isStagingMode() ? "on" : "off"}.`);
  }
} else if (command === "deploy") {
  const root = process.cwd();
  let deployArgs;
  try {
    deployArgs = parseDeployArgs(args.slice(1));
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  import("./deploy").then(({ runDeploy }) => {
    runDeploy(root, {
      projectSlug: deployArgs.projectSlug,
      dir: deployArgs.dir,
      spa: deployArgs.spa,
      skipBuild: deployArgs.skipBuild,
    }).catch((err) => {
      log.error(err.message ?? err);
      process.exit(1);
    });
  });
} else if (command === "link") {
  const root = process.cwd();
  const slug = args[1];
  runLink(root, slug).catch((err) => {
    log.error(err.message ?? err);
    process.exit(1);
  });
} else if (command === "login") {
  runLoginCommand().catch((err) => {
    log.error(err.message ?? err);
    process.exit(1);
  });
} else if (command === "logout") {
  if (removeToken()) {
    log.success("Logged out.");
  } else {
    log.info("Not logged in.");
  }
} else if (command === "whoami") {
  const token = getToken();
  if (!token) {
    log.error("Not logged in. Run `void login` first.");
    process.exit(1);
  }
  const client = new PlatformClient(token);
  client
    .whoami()
    .then((user) => {
      log.info(user.login);
    })
    .catch((err) => {
      log.error(err.message ?? err);
      process.exit(1);
    });
} else if (command === "list" || command === "ls") {
  const root = process.cwd();
  import("./list").then(({ runListCommand }) => {
    runListCommand(root, args[1]).catch((err) => {
      log.error(err.message ?? err);
      process.exit(1);
    });
  });
} else if (command === "projects") {
  runProjectsCommand().catch((err) => {
    log.error(err.message ?? err);
    process.exit(1);
  });
} else if (command === "secret") {
  const root = process.cwd();
  let secretArgs;
  try {
    secretArgs = parseSecretArgs(args.slice(1));
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  import("./secret").then(({ runSecretCommand }) => {
    runSecretCommand(root, secretArgs).catch((err) => {
      log.error(err.message ?? err);
      process.exit(1);
    });
  });
} else if (command === "token") {
  (async () => {
    if (!getToken()) {
      await runLoginCommand();
    }
    const token = getToken();
    if (!token) {
      log.error("Login failed. Run `void login` to try again.");
      process.exit(1);
    }
    const platform = process.platform;
    const cmd =
      platform === "darwin"
        ? "pbcopy"
        : platform === "win32"
          ? "clip"
          : "xclip -selection clipboard";
    try {
      execSync(cmd, { input: token });
      log.success("Token copied to clipboard.");
    } catch {
      log.warn("Could not copy to clipboard. Re-run `void login` to generate a new token.");
    }
  })().catch((err) => {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else if (command === "delete") {
  const root = process.cwd();
  import("./delete").then(({ runDeleteCommand }) => {
    runDeleteCommand(root, args[1]).catch((err) => {
      log.error(err.message ?? err);
      process.exit(1);
    });
  });
} else if (command === "domain") {
  const root = process.cwd();
  let domainArgs;
  try {
    domainArgs = parseDomainArgs(args.slice(1));
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  import("./domain").then(({ runDomainCommand }) => {
    runDomainCommand(root, domainArgs!).catch((err) => {
      log.error(err.message ?? err);
      process.exit(1);
    });
  });
} else if (command === "db") {
  const root = process.cwd();
  let dbArgs;
  try {
    dbArgs = parseDbArgs(args.slice(1));
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  import("./db").then(({ runDbCommand }) => {
    runDbCommand(root, dbArgs!).catch((err) => {
      log.error(err.message ?? err);
      process.exit(1);
    });
  });
} else if (command === "gen") {
  const root = process.cwd();
  let genArgs;
  try {
    genArgs = parseGenArgs(args.slice(1));
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  import("./gen").then(({ runGenCommand }) => {
    runGenCommand(root, genArgs!).catch((err) => {
      log.error(err.message ?? err);
      process.exit(1);
    });
  });
} else if (command === "init") {
  const root = process.cwd();
  import("./init").then(({ runInitCommand, parseInitArgs }) => {
    let initArgs;
    try {
      initArgs = parseInitArgs(args.slice(1));
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    runInitCommand(root, initArgs).catch((err) => {
      log.error(err.message ?? err);
      process.exit(1);
    });
  });
} else if (command === "mcp") {
  import("./mcp").then(({ runMcp }) => {
    runMcp();
  });
} else if (command === "-v" || command === "--version") {
  const version = JSON.parse(readFileSync(join(getPackageDir(), "package.json"), "utf-8")).version;
  console.log(version);
} else if (command && command !== "help" && command !== "--help" && command !== "-h") {
  log.error(`Unknown command: ${command}. Run \`void --help\` for usage.`);
  process.exit(1);
} else {
  const version = JSON.parse(readFileSync(join(getPackageDir(), "package.json"), "utf-8")).version;
  const art = asciiArts[Math.floor(Math.random() * asciiArts.length)];
  console.log(pc.blue(`${art}  v${version}\n`));
  note(
    [
      helpLine("void init", "Set up void in a new or existing project"),
      helpLine("  --agents", "Set up agent instructions, skills, and MCP config"),
      helpLine("  --tsconfig", "Only update tsconfig.json"),
      helpLine("  --github", "Only create GitHub Actions workflow"),
      "",
      helpLine("void deploy", "Build and deploy to Void"),
      helpLine("  --project <name>", "Deploy target project name"),
      helpLine("  --dir <path>", "Deploy a static directory (skip build)"),
      helpLine("  --spa", "Use SPA mode (default: SSG)"),
      helpLine("  --skip-build", "Skip the build step (use existing output)"),
      "",
      categoryTitle("auth"),
      helpLine("void login", "Log in with GitHub or Google"),
      helpLine("void logout", "Log out and remove credentials"),
      helpLine("void whoami", "Show the logged-in username"),
      helpLine("void token", "Copy auth token to clipboard"),
      "",
      categoryTitle("projects"),
      helpLine("void projects", "List your projects"),
      helpLine("void list, ls [name]", "List deployments for a project"),
      helpLine("void delete [name]", "Delete a project and all its resources"),
      helpLine("void link [name]", "Link to an existing project"),
      "",
      categoryTitle("secrets"),
      helpLine("void secret put <name> [--project]", "Set a project secret"),
      helpLine("void secret delete <name>", "Delete a project secret"),
      helpLine("void secret sync <file>", "Sync secrets from a dotenv file"),
      "",
      categoryTitle("domains"),
      helpLine("void domain add <hostname>", "Add a custom domain"),
      helpLine("void domain remove <hostname>", "Remove a custom domain"),
      helpLine("void domain list", "List custom domains + status"),
      helpLine("void domain status <hostname>", "Check domain verification status"),
      "",
      categoryTitle("database"),
      helpLine("void db status", "Show migration status (local + remote)"),
      helpLine("void db reset", "Reset local DB and re-run migrations"),
      helpLine("void db seed [--file <path>]", "Reset local DB, run migrations, and seed"),
      helpLine("void db execute <sql>", "Run SQL against the local database"),
      helpLine("  --file <path>", "Run SQL from a file instead"),
      helpLine("void db migrate", "Apply pending migrations locally"),
      helpLine("void db export [--output <path>]", "Export local database as SQL"),
      helpLine("  --no-data", "Schema only (no INSERT statements)"),
      helpLine("  --no-schema", "Data only (no CREATE TABLE)"),
      helpLine("  --table <name>", "Export a single table"),
      "",
      categoryTitle("codegen"),
      helpLine("void gen model <name> [cols...]", "Generate migration + CRUD routes + db types"),
      helpLine("void gen migration <name>", "Generate an empty migration file"),
      helpLine("void gen route <path> [--methods]", "Generate a route with handler exports"),
      helpLine("void gen middleware <name>", "Generate a numbered middleware file"),
      helpLine("void gen ssr [--react|--vue|...]", "Generate SSR entry + client + App component"),
      helpLine("void gen cron <name>", "Generate a cron job file"),
      helpLine("void gen queue <name>", "Generate a queue consumer file"),
      "",
      categoryTitle("agent"),
      helpLine("void init --agents", "Set up agent instructions, skills, and MCP config"),
      helpLine("void mcp", "Start MCP server (stdio, for AI agents)"),
    ].join("\n"),
    sectionTitle("Commands"),
  );

  note(
    [
      helpLine("VOID_TOKEN", "Auth token (or use `void login`)"),
      helpLine("VOID_PROJECT", "Deploy target project name override"),
    ].join("\n"),
    sectionTitle("Environment"),
  );

  outro("https://void.cloud");
}
