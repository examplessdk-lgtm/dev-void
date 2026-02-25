import { select, text, isCancel, cancel } from "@clack/prompts";

import type { ProjectResponse } from "./client";

import { getSiteDomain } from "./auth";

interface SelectResult {
  action: "select";
  project: ProjectResponse;
}

interface CreateResult {
  action: "create";
}

export type PromptResult = SelectResult | CreateResult;

export async function promptProjectSelection(
  projects: ProjectResponse[],
  message = "Select a project:",
): Promise<PromptResult> {
  const options = [
    { value: "__create__", label: "Create new project" },
    ...projects.map((p) => ({
      value: p.id,
      label: `${p.slug} (${p.slug}.${getSiteDomain()})`,
    })),
  ];

  const result = await select({
    message,
    options,
  });

  if (isCancel(result)) {
    cancel("Deploy cancelled.");
    process.exit(0);
  }

  if (result === "__create__") {
    return { action: "create" };
  }

  const project = projects.find((p) => p.id === result)!;
  return { action: "select", project };
}

export async function promptProjectSlug(defaultSlug: string): Promise<string> {
  const result = await text({
    message: "Choose a slug for your new Void project:",
    placeholder: "my-app",
    initialValue: defaultSlug,
    validate(value) {
      const slug = (value ?? "").trim();
      if (slug.length === 0) {
        return "Project slug is required.";
      }

      // Allows lowercase alphanumeric with interior dashes.
      const valid =
        slug.length === 1 ? /^[a-z0-9]$/.test(slug) : /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug);
      if (!valid) {
        return "Slug must be lowercase alphanumeric with dashes.";
      }

      return undefined;
    },
  });

  if (isCancel(result)) {
    cancel("Deploy cancelled.");
    process.exit(0);
  }

  return result.trim();
}
