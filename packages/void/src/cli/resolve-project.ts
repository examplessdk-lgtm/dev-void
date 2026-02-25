import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ProjectResponse } from "./client";
import type { ProjectConfig } from "./project";

export function getRequestedProjectSlug(options?: { projectSlug?: string }): string | null {
  const cliSlug = options?.projectSlug?.trim();
  if (cliSlug) {
    return cliSlug;
  }

  const envSlug = process.env.VOID_PROJECT?.trim();
  if (envSlug) {
    return envSlug;
  }

  return null;
}

export function resolveProjectBySlug(
  projects: ProjectResponse[],
  slug: string,
): ProjectConfig | null {
  const project = projects.find((candidate) => candidate.slug === slug);
  return project ? { projectId: project.id, slug: project.slug } : null;
}

export function inferDefaultSlug(root: string): string {
  const pkgPath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const name: string = pkg.name ?? "my-app";
  return name.replace(/^@[^/]+\//, "").replace(/[^a-z0-9-]/g, "-");
}
