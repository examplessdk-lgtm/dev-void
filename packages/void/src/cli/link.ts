import { intro, outro, log, cancel } from "@clack/prompts";

import { getToken, getSiteDomain } from "./auth";
import { PlatformClient } from "./client";
import { cliTitle } from "./output";
import { readProjectConfig, writeProjectConfig } from "./project";
import { promptProjectSelection, promptProjectSlug } from "./prompt";
import { inferDefaultSlug } from "./resolve-project";

export async function runLink(root: string, slug?: string): Promise<void> {
  console.log();
  intro(cliTitle("link"));

  // Check if already linked
  const existing = readProjectConfig(root);
  if (existing) {
    log.warn(`Already linked to ${existing.slug} (${existing.slug}.${getSiteDomain()})`);
    outro("To re-link, delete .void/project.json and run again.");
    return;
  }

  // Auth
  const token = getToken();
  if (!token) {
    cancel("No auth token found. Run `void login` first.");
    process.exit(1);
  }

  const client = new PlatformClient(token);
  const projects = await client.listProjects();

  if (slug) {
    // Non-interactive: link by slug
    const project = projects.find((p) => p.slug === slug);
    if (!project) {
      cancel(`No project found with slug "${slug}".`);
      process.exit(1);
    }
    writeProjectConfig(root, { projectId: project.id, slug: project.slug });
    outro(`Linked to ${project.slug} (${project.slug}.${getSiteDomain()})`);
    return;
  }

  // Interactive: prompt user to select or create
  const result = await promptProjectSelection(projects);

  if (result.action === "create") {
    const slug = await promptProjectSlug(inferDefaultSlug(root));
    log.step(`Creating project "${slug}"...`);
    const created = await client.createProject(slug);
    writeProjectConfig(root, { projectId: created.id, slug: created.slug });
    outro(`Created and linked to ${created.slug} (${created.slug}.${getSiteDomain()})`);
    return;
  }

  writeProjectConfig(root, { projectId: result.project.id, slug: result.project.slug });
  outro(`Linked to ${result.project.slug} (${result.project.slug}.${getSiteDomain()})`);
}
