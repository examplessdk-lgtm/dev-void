import { intro, outro, log } from "@clack/prompts";

import { getToken } from "./auth";
import { PlatformClient, type DeploymentResponse } from "./client";
import { cliTitle, dim, pc, tablePrefix } from "./output";
import { readProjectConfig } from "./project";
import { resolveProjectBySlug } from "./resolve-project";

export async function runListCommand(root: string, slug?: string): Promise<void> {
  console.log();
  intro(cliTitle("list"));

  const token = getToken();
  if (!token) {
    log.error("Not logged in. Run `void login` first.");
    process.exit(1);
  }

  const client = new PlatformClient(token);

  let projectId: string;
  let projectSlug: string;

  if (slug) {
    const projects = await client.listProjects();
    const config = resolveProjectBySlug(projects, slug);
    if (!config) {
      log.error(`No project found with slug "${slug}".`);
      process.exit(1);
    }
    projectId = config.projectId;
    projectSlug = slug;
  } else {
    const linked = readProjectConfig(root);
    if (!linked) {
      log.error("No linked project found. Pass a project name: void list <name>");
      process.exit(1);
    }
    projectId = linked.projectId;
    projectSlug = linked.slug;
  }

  await showDeployments(client, projectId, projectSlug);
}

async function showDeployments(
  client: PlatformClient,
  projectId: string,
  slug: string,
): Promise<void> {
  const deployments = await client.listDeployments(projectId);

  if (deployments.length === 0) {
    outro(`No deployments for ${slug}.`);
    return;
  }

  const rows = deployments.map((d) => formatDeploymentRow(d));

  const idWidth = Math.max("id".length, ...rows.map((r) => r.id.length));
  const modeWidth = Math.max("mode".length, ...rows.map((r) => r.mode.length));
  const statusWidth = Math.max("status".length, ...rows.map((r) => r.statusRaw.length));
  const sourceWidth = Math.max("source".length, ...rows.map((r) => r.source.length));
  const commitWidth = Math.max("commit".length, ...rows.map((r) => r.commit.length));
  const isrWidth = Math.max("isr".length, ...rows.map((r) => r.isr.length));

  const prefix = tablePrefix();
  const header = `${prefix}${dim(`${"id".padEnd(idWidth)}  ${"mode".padEnd(modeWidth)}  ${"status".padEnd(statusWidth)}  ${"source".padEnd(sourceWidth)}  ${"commit".padEnd(commitWidth)}  ${"isr".padEnd(isrWidth)}  deployed`)}`;

  const lines = rows.map(
    (row) =>
      `${prefix}${row.id.padEnd(idWidth)}  ${row.mode.padEnd(modeWidth)}  ${row.statusColored}${"".padEnd(statusWidth - row.statusRaw.length)}  ${row.source.padEnd(sourceWidth)}  ${row.commit.padEnd(commitWidth)}  ${row.isr.padEnd(isrWidth)}  ${row.deployed}`,
  );

  console.log(prefix);
  console.log(header);
  for (const line of lines) console.log(line);
  outro(`${slug} — ${deployments.length} deployment(s)`);
}

interface DeploymentRow {
  id: string;
  mode: string;
  statusRaw: string;
  statusColored: string;
  source: string;
  commit: string;
  isr: string;
  deployed: string;
}

function formatDeploymentRow(d: DeploymentResponse): DeploymentRow {
  let manifest: { static?: string; framework?: boolean; revalidate?: number } | null = null;
  if (d.manifest) {
    try {
      manifest = JSON.parse(d.manifest);
    } catch {
      // ignore
    }
  }

  const mode = manifest?.static ?? (manifest?.framework ? "framework" : "fullstack");
  const isr = manifest?.revalidate && manifest.revalidate > 0 ? `${manifest.revalidate}s` : "-";
  const source = d.source ?? "-";
  const commit = d.commit ? d.commit.slice(0, 7) : "-";

  const statusRaw = d.status;
  let statusColored = statusRaw;
  if (d.status === "live") {
    statusColored = pc.green(statusRaw);
  } else if (d.status === "failed") {
    statusColored = pc.red(statusRaw);
  }

  const deployed = d.deployed_at ? formatRelativeTime(d.deployed_at) : "-";

  return { id: d.id, mode, statusRaw, statusColored, source, commit, isr, deployed };
}

function formatRelativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return "just now";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
