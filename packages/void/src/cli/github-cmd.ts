import { cancel, isCancel, log, select, text } from '@clack/prompts';
import { openBrowser, getToken } from './auth.ts';
import {
  PlatformApiError,
  PlatformClient,
  parsePlatformErrorBody,
  type GithubInstallation,
} from './client.ts';
import { collectGitDeployMetadata } from './git-metadata.ts';
import type { GithubArgs } from './github-args.ts';
import { pc } from './output.ts';
import { readProjectConfig } from './project.ts';
import { getRequestedProjectSlug, resolveProjectBySlug } from './resolve-project.ts';

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Extract `owner/repo` from a `https://github.com/owner/repo(.git)?` URL.
 * Returns null for non-GitHub URLs or null input.
 */
export function parseGithubRepoFullName(repositoryUrl: string | null): string | null {
  if (!repositoryUrl) {
    return null;
  }
  try {
    const url = new URL(repositoryUrl);
    if (url.hostname !== 'github.com') {
      return null;
    }
    // pathname is like /owner/repo or /owner/repo.git
    const parts = url.pathname
      .replace(/^\//, '')
      .replace(/\.git$/, '')
      .split('/');
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      return null;
    }
    return `${parts[0]}/${parts[1]}`;
  } catch {
    return null;
  }
}

/**
 * Format a list of GitHub App installations into a human-readable string.
 * One block per installation:
 *   account_login (account_type) — selection, N repos, status
 *   [repo list for 'selected' installs]
 */
export function formatInstallations(installations: Array<GithubInstallation>): string {
  return installations
    .map((inst) => {
      const header = `${inst.account_login} (${inst.account_type}) — ${inst.repository_selection}, ${inst.repositories.length} repos, ${inst.status}`;
      if (inst.repository_selection === 'selected' && inst.repositories.length > 0) {
        const repos = inst.repositories.map((r) => `  • ${r.full_name}`).join('\n');
        return `${header}\n${repos}`;
      }
      return header;
    })
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function runGithubCommand(root: string, args: GithubArgs): Promise<void> {
  const token = getToken(root);
  if (!token) {
    log.error('Not logged in. Run `void auth login` first.');
    process.exit(1);
  }
  const client = new PlatformClient(token, { root });

  switch (args.subcommand) {
    case 'install':
      return runInstall(root, client);
    case 'installations':
      return runInstallations(client);
    case 'connect':
      return runConnect(root, client, args);
  }
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

async function runInstall(root: string, client: PlatformClient): Promise<void> {
  let url: string;
  try {
    ({ url } = await client.getGithubInstallUrl());
  } catch (err) {
    if (err instanceof PlatformApiError && err.status === 403) {
      log.error(
        'Your account has no linked GitHub identity. Run `void auth login` and choose GitHub.',
      );
      process.exit(1);
    }
    throw err;
  }

  log.message(`Open this URL to install the Void GitHub App:\n${pc.cyan(url)}`);
  const { exec } = await import('node:child_process');
  openBrowser(url, exec);
  log.message('After installing, run `void github connect` to link a repository to your project.');
}

// ---------------------------------------------------------------------------
// installations
// ---------------------------------------------------------------------------

async function runInstallations(client: PlatformClient): Promise<void> {
  const installations = await client.listGithubInstallations();
  if (installations.length === 0) {
    log.info('No GitHub App installations. Run `void github install` first.');
    return;
  }
  log.message(formatInstallations(installations));
}

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

async function runConnect(
  root: string,
  client: PlatformClient,
  args: Extract<GithubArgs, { subcommand: 'connect' }>,
): Promise<void> {
  const isTTY = process.stdin.isTTY === true;

  // -------------------------------------------------------------------------
  // 1. Resolve project
  // -------------------------------------------------------------------------
  let projectId: string;

  const requestedSlug = getRequestedProjectSlug({ projectSlug: args.projectName || undefined });

  if (requestedSlug) {
    const projects = await client.listProjects();
    const resolved = resolveProjectBySlug(projects, requestedSlug);
    if (!resolved) {
      log.error(`connect: No project found with slug '${requestedSlug}'.`);
      process.exit(1);
    }
    projectId = resolved.projectId;
  } else {
    const linked = readProjectConfig(root);
    if (linked) {
      projectId = linked.projectId;
    } else if (!isTTY) {
      log.error('connect: No project specified. Pass a project name or --project <name>.');
      process.exit(1);
    } else {
      // Prompt to pick from list
      const projects = await client.listProjects();
      if (projects.length === 0) {
        log.error('No projects found. Create one first with `void deploy`.');
        process.exit(1);
      }
      const picked = await select({
        message: 'Select a project:',
        options: projects.map((p) => ({ value: p.id, label: p.slug })),
      });
      if (isCancel(picked)) {
        cancel('Cancelled.');
        process.exit(0);
      }
      projectId = picked as string;
    }
  }

  // -------------------------------------------------------------------------
  // 2. Resolve installation
  // -------------------------------------------------------------------------
  const installations = (await client.listGithubInstallations()).filter(
    (i) => i.status === 'active',
  );

  if (installations.length === 0) {
    log.error('No active GitHub App installation. Run `void github install` first.');
    process.exit(1);
  }

  let installation: GithubInstallation;

  if (args.installationId) {
    const found = installations.find((i) => i.installation_id === args.installationId);
    if (!found) {
      log.error(`connect: No active installation found with id '${args.installationId}'.`);
      process.exit(1);
    }
    installation = found;
  } else if (installations.length === 1) {
    installation = installations[0]!;
  } else if (!isTTY) {
    log.error('connect: Multiple installations found. Pass --installation <id>.');
    process.exit(1);
  } else {
    const picked = await select({
      message: 'Select a GitHub App installation:',
      options: installations.map((i) => ({
        value: i.installation_id,
        label: `${i.account_login} (${i.account_type})`,
      })),
    });
    if (isCancel(picked)) {
      cancel('Cancelled.');
      process.exit(0);
    }
    installation = installations.find((i) => i.installation_id === picked)!;
  }

  // -------------------------------------------------------------------------
  // 3. Resolve repo full name
  // -------------------------------------------------------------------------
  let repoFullName: string;

  if (args.repo) {
    repoFullName = args.repo;
  } else if (installation.repository_selection === 'selected') {
    if (installation.repositories.length === 0) {
      log.error(
        'connect: The installation has no accessible repositories. Update the GitHub App install to grant access.',
      );
      process.exit(1);
    }
    if (!isTTY) {
      log.error('connect: Multiple repositories available. Pass --repo <owner/repo>.');
      process.exit(1);
    }
    const picked = await select({
      message: 'Select a repository:',
      options: installation.repositories.map((r) => ({ value: r.full_name, label: r.full_name })),
    });
    if (isCancel(picked)) {
      cancel('Cancelled.');
      process.exit(0);
    }
    repoFullName = picked as string;
  } else {
    // 'all' — repos not enumerable; fall back to git
    const gitDefault = parseGithubRepoFullName(collectGitDeployMetadata(root, null).repositoryUrl);
    if (!isTTY) {
      if (!gitDefault) {
        log.error('connect: Cannot detect repository from git. Pass --repo <owner/repo>.');
        process.exit(1);
      }
      repoFullName = gitDefault;
    } else {
      const input = await text({
        message: 'Repository (owner/repo):',
        placeholder: gitDefault ?? 'owner/repo',
        initialValue: gitDefault ?? '',
      });
      if (isCancel(input)) {
        cancel('Cancelled.');
        process.exit(0);
      }
      repoFullName = (input as string).trim();
      if (!repoFullName) {
        log.error('connect: Repository is required.');
        process.exit(1);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 4. Resolve branch
  // -------------------------------------------------------------------------
  const branchDefault = args.branch ?? collectGitDeployMetadata(root, null).gitRef ?? 'main';

  let branch: string;
  if (args.branch) {
    branch = args.branch;
  } else if (!isTTY) {
    branch = branchDefault;
  } else {
    const input = await text({
      message: 'Branch to deploy from:',
      placeholder: branchDefault,
      initialValue: branchDefault,
    });
    if (isCancel(input)) {
      cancel('Cancelled.');
      process.exit(0);
    }
    branch = ((input as string) || branchDefault).trim();
  }

  // -------------------------------------------------------------------------
  // 5. Executor
  // -------------------------------------------------------------------------
  const executor = args.executor ?? 'container';

  // -------------------------------------------------------------------------
  // 6. Connect
  // -------------------------------------------------------------------------
  try {
    await client.connectGithub(projectId, {
      installationId: installation.installation_id,
      repoFullName,
      branch,
      buildExecutor: executor,
    });
  } catch (err) {
    if (err instanceof PlatformApiError) {
      const body = parsePlatformErrorBody(err.body);
      const code = body?.error ?? body?.message ?? '';

      if (err.status === 409) {
        if (code === 'already_connected') {
          log.error('connect: This project is already connected to a repository.');
        } else {
          log.error(
            'connect: Installation is not active. Re-install the GitHub App and try again.',
          );
        }
        process.exit(1);
      }
      if (err.status === 400) {
        log.error(`connect: Repository '${repoFullName}' is not accessible via this installation.`);
        process.exit(1);
      }
      if (err.status === 403) {
        log.error('connect: Forbidden. Check that you own the project and the installation.');
        process.exit(1);
      }
      if (err.status === 404) {
        log.error('connect: Project or installation not found.');
        process.exit(1);
      }
      throw err;
    }
    throw err;
  }

  log.success(`Connected ${repoFullName} (${branch}) → project. Push to ${branch} to deploy.`);
}
