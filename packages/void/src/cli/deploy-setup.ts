import { cancel, confirm, isCancel, log, select, spinner } from "@clack/prompts";
import { PlatformClient } from "./client";
import { getToken, isStagingMode, runLogin, saveToken } from "./auth";
import { promptProjectSelection, promptProjectSlug } from "./prompt";
import { inferDefaultSlug } from "./resolve-project";
import { readProjectConfig, writeProjectConfig, type ProjectConfig } from "./project";

async function promptForLoginToken(): Promise<string> {
  const provider = await select({
    message: "Choose a login provider:",
    options: [
      { value: "github", label: "GitHub" },
      { value: "google", label: "Google" },
    ],
  });

  if (isCancel(provider)) {
    cancel("Setup cancelled.");
    process.exit(0);
  }

  const providerName = provider === "github" ? "GitHub" : "Google";
  const s = spinner();
  s.start(`Opening browser for ${providerName} login...`);

  try {
    const token = await runLogin(provider);
    saveToken(token);
    s.stop("Logged in!");
    log.success(isStagingMode() ? "Staging token saved." : "Token saved.");
    return token;
  } catch (error) {
    s.stop("Login failed");
    throw error;
  }
}

async function ensureToken(): Promise<string> {
  const existing = getToken();
  if (existing) {
    return existing;
  }

  return promptForLoginToken();
}

async function createProject(
  root: string,
  client: PlatformClient,
  slug: string,
): Promise<ProjectConfig> {
  log.step(`Creating project "${slug}"...`);
  const project = await client.createProject(slug);
  const config = { projectId: project.id, slug: project.slug };
  writeProjectConfig(root, config);
  log.success(`Project created and linked: ${config.slug}`);
  return config;
}

export async function maybeSetupDeployProject(root: string): Promise<ProjectConfig | null> {
  const existing = readProjectConfig(root);
  if (existing) {
    log.info(`Project already linked: ${existing.slug}`);
    return existing;
  }

  const existingToken = getToken();
  const shouldSetup = await confirm({
    message: existingToken
      ? "Link your Void project now?"
      : "Set up your Void project now? (log in + link project)",
  });
  if (isCancel(shouldSetup)) {
    cancel("Setup cancelled.");
    process.exit(0);
  }
  if (!shouldSetup) {
    return null;
  }

  const token = existingToken ?? (await ensureToken());
  const client = new PlatformClient(token);
  const projects = await client.listProjects();

  if (projects.length === 0) {
    const slug = await promptProjectSlug(inferDefaultSlug(root));
    return createProject(root, client, slug);
  }

  const result = await promptProjectSelection(projects, "Select a project to link:");
  if (result.action === "select") {
    const config = { projectId: result.project.id, slug: result.project.slug };
    writeProjectConfig(root, config);
    log.success(`Linked project: ${config.slug}`);
    return config;
  }

  const slug = await promptProjectSlug(inferDefaultSlug(root));
  return createProject(root, client, slug);
}
