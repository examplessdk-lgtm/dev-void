import { randomBytes } from 'node:crypto';
import { cancel, isCancel, log, select, text } from '@clack/prompts';
import {
  awaitBrowserCallback,
  createCodeChallenge,
  createCodeVerifier,
  openBrowser,
  getToken,
} from './auth.ts';
import {
  PlatformApiError,
  PlatformClient,
  parsePlatformErrorBody,
  type GithubConnection,
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
 * Map a PlatformApiError status + error code string to a friendly user message.
 * Returns null for unrecognised cases (caller should re-throw).
 */
export function describeConnectError(status: number, errorCode: string | undefined): string | null {
  const code = errorCode ?? '';
  if (status === 409) {
    if (code.includes('already connected')) {
      return 'This project is already connected to a GitHub repository.';
    }
    if (code.includes('not active')) {
      return 'Installation is not active. Re-install the GitHub App and try again.';
    }
  }
  if (status === 400 && code.includes('not accessible')) {
    return 'Repository not accessible by this installation. Check the App has access to it.';
  }
  if (status === 403) {
    return "You don't have access to this project.";
  }
  if (status === 404) {
    return 'Project or installation not found.';
  }
  return null;
}

/**
 * Like {@link describeConnectError}, but for `void github update`. The update
 * flow starts from an EXISTING connection, so a 404 "connection not found"
 * (the project has no GitHub connection, or it was disconnected between the
 * read and the write) is the common case and gets a "connect first" message.
 * Everything else defers to the shared connect mapping.
 */
export function describeUpdateError(status: number, errorCode: string | undefined): string | null {
  const code = errorCode ?? '';
  if (status === 404 && code.includes('connection not found')) {
    return 'This project is not connected to a GitHub repository. Run `void github connect` first.';
  }
  return describeConnectError(status, code);
}

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
      const header = `${inst.account_login} (${inst.account_type}) [id: ${inst.installation_id}] — ${inst.repository_selection}, ${inst.repositories.length} repos, ${inst.status}`;
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
    case 'update':
      return runGithubUpdate(root, client, args);
    case 'link':
      return runGithubLink(root, client);
  }
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

/**
 * `void github install` — print the GitHub App install URL and open it.
 *
 * If the account has no linked GitHub identity, the server returns a 403 with
 * the stable code `github_identity_required` (Task 3). Rather than telling the
 * user to `void auth login` (which risks forking into a second account), we run
 * the link flow inline and retry the install URL exactly once.
 *
 * `linkIdentity` is injectable so tests can supply a fake linker instead of
 * starting a real localhost callback server / browser.
 */
export async function runInstall(
  root: string,
  client: PlatformClient,
  linkIdentity: (root: string, client: PlatformClient) => Promise<void> = runGithubLink,
): Promise<void> {
  let url: string;
  try {
    ({ url } = await client.getGithubInstallUrl());
  } catch (err) {
    if (
      err instanceof PlatformApiError &&
      err.status === 403 &&
      err.code === 'github_identity_required'
    ) {
      log.message('Your Void account needs a linked GitHub identity. Starting the GitHub link…');
      await linkIdentity(root, client);
      try {
        ({ url } = await client.getGithubInstallUrl());
      } catch (retryErr) {
        // Only the SAME identity-required 403 means linking didn't take — show
        // the actionable link/install guidance. Any other failure (401, 426,
        // 500, a different 403) is the real error and must surface normally.
        if (
          retryErr instanceof PlatformApiError &&
          retryErr.status === 403 &&
          retryErr.code === 'github_identity_required'
        ) {
          log.error(
            'Could not start the GitHub App install after linking. Try `void github link`, then `void github install` again.',
          );
          process.exit(1);
        }
        throw retryErr;
      }
    } else {
      throw err;
    }
  }

  log.message(`Open this URL to install the Void GitHub App:\n${pc.cyan(url)}`);
  const { execFile } = await import('node:child_process');
  openBrowser(url, execFile);
  log.message('After installing, run `void github connect` to link a repository to your project.');
}

// ---------------------------------------------------------------------------
// link
// ---------------------------------------------------------------------------

/**
 * Link the current Void account (the logged-in CLI token holder) to a GitHub
 * identity. Drives the platform's 3-endpoint link flow with a localhost +
 * PKCE handshake, mirroring `void auth login`.
 *
 * Exported so Task 5 can call it (e.g. when `github install` returns 403 for a
 * GitHub-less account, prompt to link and retry). The success path is
 * non-exiting so a caller can continue; only error paths exit/throw.
 */
export async function runGithubLink(root: string, client: PlatformClient): Promise<void> {
  void root; // Reserved for the signature Task 5 reuses; routing uses `client`.

  const verifier = createCodeVerifier();
  const challenge = createCodeChallenge(verifier);
  const state = randomBytes(32).toString('hex');

  // completeGithubLink runs INSIDE the request handler (via finalize), so the
  // browser only shows the success page after the link actually succeeds; a 409
  // conflict rejects out of awaitBrowserCallback and is mapped below.
  let status: 'linked' | 'already_linked';
  try {
    ({ status } = await awaitBrowserCallback<{ status: 'linked' | 'already_linked' }>({
      state,
      buildAuthUrl: async (callback) => {
        callback.searchParams.set('state', state);
        const { url } = await client.getGithubLinkUrl(callback.href, challenge);
        return url;
      },
      describeError: (p) => (p.get('error') ? 'GitHub authorization failed.' : null),
      onUrl: (url) => log.message(`Open this URL to link your GitHub account:\n${pc.cyan(url)}`),
      finalize: async (params) => {
        const linkCode = params.get('link_code');
        if (!linkCode) {
          throw new Error('github: link callback did not return a link code.');
        }
        return client.completeGithubLink(linkCode, verifier);
      },
    }));
  } catch (err) {
    if (err instanceof PlatformApiError && err.code === 'github_already_linked') {
      log.error('Your Void account is already linked to a different GitHub account.');
      process.exit(1);
    }
    if (
      err instanceof PlatformApiError &&
      (err.status === 409 || err.code === 'github_identity_conflict')
    ) {
      log.error('This GitHub account is already linked to another Void account.');
      process.exit(1);
    }
    throw err;
  }

  if (status === 'already_linked') {
    log.success('GitHub account already linked.');
  } else {
    log.success('GitHub account linked.');
  }
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
      log.error(
        'connect: No project specified. Pass a project name or --project <name>, set VOID_PROJECT, or link one with `void project link`.',
      );
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
        label: `${i.account_login} (${i.account_type}) [id: ${i.installation_id}]`,
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
    } else if (installation.repositories.length === 1) {
      repoFullName = installation.repositories[0]!.full_name;
    } else if (!isTTY) {
      log.error('connect: Multiple repositories available. Pass --repo <owner/repo>.');
      process.exit(1);
    } else {
      const picked = await select({
        message: 'Select a repository:',
        options: installation.repositories.map((r) => ({ value: r.full_name, label: r.full_name })),
      });
      if (isCancel(picked)) {
        cancel('Cancelled.');
        process.exit(0);
      }
      repoFullName = picked as string;
    }
  } else {
    // 'all' — repos aren't enumerable. Do NOT infer the repo from git in CI:
    // GITHUB_REPOSITORY / origin can point at a fork or the wrong checkout and
    // would silently bind the project to the wrong repo. Require --repo, the
    // same way --branch is required in non-interactive mode.
    if (!isTTY) {
      log.error(
        'connect: --repo <owner/repo> is required in non-interactive mode for an all-repositories installation.',
      );
      process.exit(1);
    }
    const gitDefault = parseGithubRepoFullName(collectGitDeployMetadata(root, null).repositoryUrl);
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

  // -------------------------------------------------------------------------
  // 4. Resolve branch
  // -------------------------------------------------------------------------
  const branchDefault = args.branch ?? collectGitDeployMetadata(root, null).gitRef ?? 'main';

  let branch: string;
  if (args.branch) {
    branch = args.branch;
  } else if (!isTTY) {
    log.error('connect: --branch is required in non-interactive mode. Pass --branch <name>.');
    process.exit(1);
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
    branch = (input as string).trim() || branchDefault;
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
      const message = describeConnectError(err.status, code);
      if (message !== null) {
        log.error(`connect: ${message}`);
        process.exit(1);
      }
      throw err;
    }
    throw err;
  }

  log.success(`Connected ${repoFullName} (${branch}) → project. Push to ${branch} to deploy.`);
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

export async function runGithubUpdate(
  root: string,
  client: PlatformClient,
  args: Extract<GithubArgs, { subcommand: 'update' }>,
): Promise<void> {
  const isTTY = process.stdin.isTTY === true;

  // Non-TTY needs at least one flag to act on — there is nothing to prompt for.
  // Guard BEFORE any project resolution or connection read so this usage error
  // never depends on API state (e.g. a disconnected project must not surface the
  // "connect first" 404 message in place of the missing-flags error).
  if (!isTTY && args.branch === undefined && args.executor === undefined) {
    log.error(
      'update: Nothing to update. Pass --branch <name> and/or --executor <container|github_actions>.',
    );
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // 1. Resolve project (identical resolution order to `connect`).
  // -------------------------------------------------------------------------
  let projectId: string;

  const requestedSlug = getRequestedProjectSlug({ projectSlug: args.projectName || undefined });

  if (requestedSlug) {
    const projects = await client.listProjects();
    const resolved = resolveProjectBySlug(projects, requestedSlug);
    if (!resolved) {
      log.error(`update: No project found with slug '${requestedSlug}'.`);
      process.exit(1);
    }
    projectId = resolved.projectId;
  } else {
    const linked = readProjectConfig(root);
    if (linked) {
      projectId = linked.projectId;
    } else if (!isTTY) {
      log.error(
        'update: No project specified. Pass a project name or --project <name>, set VOID_PROJECT, or link one with `void project link`.',
      );
      process.exit(1);
    } else {
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
  // 2. Fetch the current connection. A missing connection (404) means the
  //    project was never connected — mirror the API's 404 semantics and point
  //    the user at `connect` instead of a raw error.
  // -------------------------------------------------------------------------
  let current: GithubConnection;
  try {
    current = await client.getGithubConnection(projectId);
  } catch (err) {
    if (err instanceof PlatformApiError) {
      const body = parsePlatformErrorBody(err.body);
      const code = body?.error ?? body?.message ?? '';
      const message = describeUpdateError(err.status, code);
      if (message !== null) {
        log.error(`update: ${message}`);
        process.exit(1);
      }
    }
    throw err;
  }

  // -------------------------------------------------------------------------
  // 3. Resolve the new branch + executor. TTY defaults to the current value;
  //    non-TTY requires at least one flag (nothing to prompt for).
  // -------------------------------------------------------------------------
  let branch: string;
  let executor: 'container' | 'github_actions';

  if (isTTY) {
    if (args.branch !== undefined) {
      branch = args.branch;
    } else {
      const input = await text({
        message: 'Branch to deploy from:',
        placeholder: current.branch,
        initialValue: current.branch,
      });
      if (isCancel(input)) {
        cancel('Cancelled.');
        process.exit(0);
      }
      branch = (input as string).trim() || current.branch;
    }

    if (args.executor !== undefined) {
      executor = args.executor;
    } else {
      const picked = await select({
        message: 'Build executor:',
        options: [
          { value: 'container', label: 'container' },
          { value: 'github_actions', label: 'github_actions' },
        ],
        initialValue: current.build_executor,
      });
      if (isCancel(picked)) {
        cancel('Cancelled.');
        process.exit(0);
      }
      executor = picked as 'container' | 'github_actions';
    }
  } else {
    // The missing-flags guard at the top of this function already guaranteed at
    // least one of --branch / --executor is present in non-TTY mode.
    branch = args.branch ?? current.branch;
    executor = args.executor ?? current.build_executor;
  }

  // -------------------------------------------------------------------------
  // 4. Build a patch carrying ONLY the fields that actually changed.
  // -------------------------------------------------------------------------
  const patch: { branch?: string; buildExecutor?: 'container' | 'github_actions' } = {};
  if (branch !== current.branch) {
    patch.branch = branch;
  }
  if (executor !== current.build_executor) {
    patch.buildExecutor = executor;
  }

  // -------------------------------------------------------------------------
  // 5. No-op guard — never hit the API when nothing changed.
  // -------------------------------------------------------------------------
  if (patch.branch === undefined && patch.buildExecutor === undefined) {
    log.info(
      `No changes. ${current.repo_full_name} already deploys from ${current.branch} via ${current.build_executor}.`,
    );
    return;
  }

  // -------------------------------------------------------------------------
  // 6. Update.
  // -------------------------------------------------------------------------
  let updated: GithubConnection;
  try {
    updated = await client.updateGithubConnection(projectId, patch);
  } catch (err) {
    if (err instanceof PlatformApiError) {
      const body = parsePlatformErrorBody(err.body);
      const code = body?.error ?? body?.message ?? '';
      const message = describeUpdateError(err.status, code);
      if (message !== null) {
        log.error(`update: ${message}`);
        process.exit(1);
      }
      throw err;
    }
    throw err;
  }

  log.success(
    `Updated ${updated.repo_full_name} → branch ${updated.branch}, executor ${updated.build_executor}.`,
  );
}
