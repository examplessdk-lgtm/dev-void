import { intro, outro, log } from "@clack/prompts";

import { getToken, getSiteDomain } from "./auth";
import { PlatformClient } from "./client";
import { cliTitle, dim, pc, tablePrefix } from "./output";

export async function runProjectsCommand(): Promise<void> {
  console.log();
  intro(cliTitle("projects"));

  const token = getToken();
  if (!token) {
    log.error("Not logged in. Run `void login` first.");
    process.exit(1);
  }

  const client = new PlatformClient(token);
  const projects = await client.listProjects();

  if (projects.length === 0) {
    outro("No projects found.");
    return;
  }

  const rows = projects.map((p) => ({
    slug: p.slug,
    mode: p.mode ?? "worker",
    url: p.custom_domain ? `https://${p.custom_domain}` : `https://${p.slug}.${getSiteDomain()}`,
  }));

  const slugWidth = Math.max("slug".length, ...rows.map((r) => r.slug.length));
  const modeWidth = Math.max("mode".length, ...rows.map((r) => r.mode.length));

  const prefix = tablePrefix();
  const header = `${prefix}${dim(`${"slug".padEnd(slugWidth)}  ${"mode".padEnd(modeWidth)}  url`)}`;
  const lines = rows.map(
    (row) =>
      `${prefix}${pc.green(row.slug)}${"".padEnd(slugWidth - row.slug.length)}  ${row.mode.padEnd(modeWidth)}  ${row.url}`,
  );
  console.log(prefix);
  console.log(header);
  for (const line of lines) console.log(line);
  outro(`${projects.length} project(s)`);
}
