import { randomBytes } from 'node:crypto';
import { cancel, confirm, isCancel, log, select, text } from '@clack/prompts';
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
import { platformErrorMessage } from './platform-errors.ts';
import { readProjectConfig } from './project.ts';
import { getRequestedProjectSlug, resolveProjectBySlug } from './resolve-project.ts';

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * The workflow file `void init --github` scaffolds and the platform default for
 * a connection's OIDC deploy pin. Kept in sync with the server default
 * (`github_connections.workflow_path`) and the `init.ts` scaffolder.
 */
export const DEFAULT_WORKFLOW_PATH = '.github/workflows/void-deploy.yml';

/**
 * Client-side mirror of the server's `isValidWorkflowPath` (packages/api
 * routes/github.ts). Used to reject a bad path at the interactive prompt before
 * an API round-trip. The server re-validates, so this is DX only, not security.
 */
export function isValidWorkflowPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.startsWith('.github/workflows/') &&
    (path.endsWith('.yml') || path.endsWith('.yaml')) &&
    !path.includes('..')
  );
}

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

function describeGithubClientError(
  error: PlatformApiError,
  describe: typeof describeConnectError,
): string | null {
  const body = parsePlatformErrorBody(error.body);
  // The client knows whether this was a project read, settings change, or an
  // account-level GitHub operation. A 403 alone does not identify the cause.
  if (platformErrorMessage(body) || error.status === 403) {
    return error.message;
  }
  return describe(error.status, error.code);
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

/**
 * Render a GitHub connection as an aligned key/value block for `void github
 * status`. The workflow file is the OIDC deploy pin — it is only read for
 * github_actions builds (container builds never use it), so it is annotated as
 * unused when the executor is container to avoid implying it is active.
 */
export function formatConnection(connection: GithubConnection): string {
  const row = (label: string, value: string): string => `  ${label.padEnd(16)}${value}`;
  const workflow =
    connection.build_executor === 'github_actions'
      ? connection.workflow_path
      : `${connection.workflow_path} (unused for container builds)`;
  const rows = [
    row('Repository', connection.repo_full_name),
    row('Branch', connection.branch),
    row('Build executor', connection.build_executor),
    row('Deploy workflow', workflow),
  ];
  return rows.join('\n');
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function runGithubCommand(root: string, args: GithubArgs): Promise<void> {
  const token = getToken(root);
  if (!token) {
    log.error('Not logged in. Run `void account login` first.');
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
    case 'status':
      return runStatus(root, client, args);
    case 'disconnect':
      return runGithubDisconnect(root, client, args);
    case 'link':
      return runGithubLink(root, client);
    case 'join':
      return runGithubJoin(root, client);
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
 * user to `void account login` (which risks forking into a second account), we run
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
 * PKCE handshake, mirroring `void account login`.
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
// join
// ---------------------------------------------------------------------------

/**
 * Browser round-trip (localhost + PKCE) that joins the caller to their
 * organization's shared GitHub App installations. Returns the number of
 * installations joined. Throws PlatformApiError — including the 503
 * `github_oauth_not_configured` — so callers own the user-facing handling
 * (`runGithubJoin` prints and exits; the connect auto-join fallback falls
 * through to its install-first error).
 */
export async function performGithubJoin(client: PlatformClient): Promise<number> {
  const verifier = createCodeVerifier();
  const challenge = createCodeChallenge(verifier);
  const state = randomBytes(32).toString('hex');

  // completeGithubJoin runs INSIDE the request handler (via finalize), so the
  // browser only shows the success page after the join actually succeeds.
  const { count } = await awaitBrowserCallback<{ status: 'joined'; count: number }>({
    state,
    buildAuthUrl: async (callback) => {
      callback.searchParams.set('state', state);
      const { url } = await client.getGithubJoinUrl(callback.href, challenge);
      return url;
    },
    describeError: (p) => (p.get('error') ? 'GitHub authorization failed.' : null),
    onUrl: (url) =>
      log.message(
        `Open this URL to join your organization's shared GitHub App installations:\n${pc.cyan(url)}`,
      ),
    finalize: async (params) => {
      const joinCode = params.get('join_code');
      if (!joinCode) {
        throw new Error('github: join callback did not return a join code.');
      }
      return client.completeGithubJoin(joinCode, verifier);
    },
  });
  return count;
}

export async function runGithubJoin(root: string, client: PlatformClient): Promise<void> {
  void root; // Signature parity with runGithubLink; routing uses `client`.

  let count: number;
  try {
    count = await performGithubJoin(client);
  } catch (err) {
    // Fail closed: org-installation sharing OAuth is not configured on this
    // instance. The membership flow has no already-joined conflict to map.
    if (
      err instanceof PlatformApiError &&
      err.status === 503 &&
      err.code === 'github_oauth_not_configured'
    ) {
      log.error('Organization installation sharing is not enabled on this Void instance.');
      process.exit(1);
    }
    throw err;
  }

  if (count === 0) {
    log.info('No new installations to join.');
  } else {
    log.success(`Joined ${count} installation${count === 1 ? '' : 's'}.`);
    log.message('Run `void github installations` to see them, then `void github connect`.');
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

/**
 * Per-repo connect authorization round-trip for a non-owner org member.
 *
 * When the connect route returns 403 `connect_authorization_required` (Task 8),
 * the member has no proof they can access the specific repo under the shared
 * installation. This drives the same localhost + PKCE handshake as
 * {@link runGithubLink}/{@link runGithubJoin}, but against the platform's
 * connect-authorize route (Task 7): the callback mints and returns the grant IN
 * the redirect URL (`?connect_grant=…`), so there is no separate `/complete`
 * POST — `finalize` just reads the grant out of the callback query. A
 * `?error=repo_not_accessible` callback is mapped to a friendly per-repo message
 * by `describeError`, which rejects out of the handshake (no grant, no retry).
 *
 * Returns the grant plus the PKCE verifier the caller must echo to the connect
 * route so the platform can bind the grant to this exchange.
 */
async function runGithubConnectAuthorize(
  client: PlatformClient,
  installationId: string,
  repoFullName: string,
): Promise<{ connectGrant: string; codeVerifier: string }> {
  const verifier = createCodeVerifier();
  const challenge = createCodeChallenge(verifier);
  const state = randomBytes(32).toString('hex');

  const { connectGrant } = await awaitBrowserCallback<{ connectGrant: string }>({
    state,
    buildAuthUrl: async (callback) => {
      callback.searchParams.set('state', state);
      const { url } = await client.getGithubConnectAuthorizeUrl(
        callback.href,
        challenge,
        installationId,
        repoFullName,
      );
      return url;
    },
    describeError: (p) => {
      const e = p.get('error');
      if (e === 'repo_not_accessible') {
        return `You don't have access to ${repoFullName} under this installation on GitHub.`;
      }
      return e ? 'GitHub authorization failed.' : null;
    },
    onUrl: (url) =>
      log.message(`Open this URL to authorize access to ${repoFullName}:\n${pc.cyan(url)}`),
    finalize: async (params) => {
      const grant = params.get('connect_grant');
      if (!grant) {
        throw new Error('github: connect authorization did not return a grant.');
      }
      return { connectGrant: grant };
    },
  });

  return { connectGrant, codeVerifier: verifier };
}

/**
 * Free-text repository prompt used when the installation's repository list is
 * not enumerable client-side: `repository_selection === 'all'`, or a shared
 * org installation whose list the server redacts for non-owner members. The
 * server re-verifies actual access on connect, so this is DX, not security.
 */
async function promptRepoFullName(root: string): Promise<string> {
  const gitDefault = parseGithubRepoFullName(collectGitDeployMetadata(root, null).repositoryUrl);
  const input = await text({
    message: 'Repository (owner/repo):',
    placeholder: gitDefault ?? 'owner/repo',
    initialValue: gitDefault ?? '',
    validate: (value) =>
      /^[^/\s]+\/[^/\s]+$/.test((value ?? '').trim())
        ? undefined
        : 'Enter the repository as owner/repo.',
  });
  if (isCancel(input)) {
    cancel('Cancelled.');
    process.exit(0);
  }
  return (input as string).trim();
}

export async function runConnect(
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
  const listActiveInstallations = async () =>
    (await client.listGithubInstallations()).filter((i) => i.status === 'active');

  // Auto-join fallback: an org member whose org already installed the App has
  // no membership row until a join round-trip records one, so their list is
  // empty (or missing the shared installation) even though the App is
  // installed. Run the join flow once instead of telling them to re-install.
  // Browser round-trips are TTY-only, mirroring every other prompt here. A 503
  // (sharing not configured) falls through to the install-first error.
  let autoJoinAttempted = false;
  const attemptAutoJoin = async (): Promise<number> => {
    autoJoinAttempted = true;
    try {
      return await performGithubJoin(client);
    } catch (err) {
      if (
        err instanceof PlatformApiError &&
        err.status === 503 &&
        err.code === 'github_oauth_not_configured'
      ) {
        return 0;
      }
      throw err;
    }
  };

  let installations = await listActiveInstallations();

  if (installations.length === 0 && isTTY) {
    log.info(
      'No GitHub App installation is linked to your account yet — checking whether your organization already installed the Void GitHub App…',
    );
    if ((await attemptAutoJoin()) > 0) {
      installations = await listActiveInstallations();
    }
  }

  if (installations.length === 0) {
    log.error(
      isTTY
        ? 'No GitHub App installation found for your account or your organizations. Run `void github install` first.'
        : 'No active GitHub App installation. Run `void github install` first, or `void github join` if your organization already installed the Void GitHub App.',
    );
    process.exit(1);
  }

  let installation: GithubInstallation;

  if (args.installationId) {
    let found = installations.find((i) => i.installation_id === args.installationId);
    if (!found && isTTY && !autoJoinAttempted) {
      log.info(
        `Installation '${args.installationId}' is not linked to your account yet — checking whether your organization shares it…`,
      );
      if ((await attemptAutoJoin()) > 0) {
        installations = await listActiveInstallations();
        found = installations.find((i) => i.installation_id === args.installationId);
      }
    }
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
      // The server redacts `repositories` to [] for every organization
      // installation. A personal installation can also genuinely have zero
      // grants. Either way the list is not enumerable here — take free text and
      // let the server's per-repository access check decide.
      if (!isTTY) {
        log.error(
          'connect: --repo <owner/repo> is required — this installation does not expose a repository list to your account.',
        );
        process.exit(1);
      }
      repoFullName = await promptRepoFullName(root);
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
    repoFullName = await promptRepoFullName(root);
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
  // 5. Executor (build backend). Non-interactive keeps the historical silent
  //    default of `container`; TTY prompts so a first-time connect is explicit.
  // -------------------------------------------------------------------------
  let executor: 'container' | 'github_actions';
  if (args.executor !== undefined) {
    executor = args.executor;
  } else if (!isTTY) {
    executor = 'container';
  } else {
    const picked = await select({
      message: 'Build executor:',
      options: [
        { value: 'container', label: 'Cloudflare Container', hint: 'build on Void (default)' },
        { value: 'github_actions', label: 'GitHub Actions', hint: "build in your repo's runner" },
      ],
      initialValue: 'container',
    });
    if (isCancel(picked)) {
      cancel('Cancelled.');
      process.exit(0);
    }
    executor = picked as 'container' | 'github_actions';
  }

  // -------------------------------------------------------------------------
  // 6. Workflow file (github_actions only — this is the per-connection OIDC
  //    deploy pin; container builds never read it). Flag wins; otherwise TTY
  //    prompts, defaulting to the scaffolded workflow.
  //
  //    Only carry a prompted value forward when it DIFFERS from the default, so
  //    accepting the default leaves `workflowPath` undefined → the field is not
  //    sent → the server applies its own (identical) default. This keeps the
  //    fail-closed echo check below from firing against an older platform that
  //    silently drops the field and returns its default.
  // -------------------------------------------------------------------------
  let workflowPath = args.workflowPath;
  if (executor === 'github_actions' && args.workflowPath === undefined && isTTY) {
    const input = await text({
      message: 'Deploy workflow file:',
      placeholder: DEFAULT_WORKFLOW_PATH,
      initialValue: DEFAULT_WORKFLOW_PATH,
      validate(value) {
        const v = (value ?? '').trim();
        if (v.length === 0 || isValidWorkflowPath(v)) {
          return;
        }
        return 'Must be under .github/workflows/, end in .yml/.yaml, and not contain "..".';
      },
    });
    if (isCancel(input)) {
      cancel('Cancelled.');
      process.exit(0);
    }
    const chosen = (input as string).trim() || DEFAULT_WORKFLOW_PATH;
    if (chosen !== DEFAULT_WORKFLOW_PATH) {
      workflowPath = chosen;
    }
  }

  // -------------------------------------------------------------------------
  // 7. Connect
  // -------------------------------------------------------------------------
  const attemptConnect = (extra?: { connectGrant: string; codeVerifier: string }) =>
    client.connectGithub(projectId, {
      installationId: installation.installation_id,
      repoFullName,
      branch,
      buildExecutor: executor,
      workflowPath,
      ...extra,
    });

  let connection: GithubConnection;
  try {
    connection = await attemptConnect();
  } catch (err) {
    if (!(err instanceof PlatformApiError)) {
      throw err;
    }
    if (err.status === 403 && err.code === 'connect_authorization_required') {
      if (!isTTY) {
        // The authorize round-trip opens a browser and blocks on a localhost callback
        // (auth.ts, up to a 5-min timeout). A non-interactive shell (CI) has no browser,
        // so fail closed immediately with an actionable message instead of hanging until
        // the callback times out — same posture as the --branch / --repo guards above.
        log.error(
          'connect: this installation requires per-repo authorization, which needs an interactive browser sign-in. Run `void github connect` locally to authorize, then retry.',
        );
        process.exit(1);
      }
      // Organization participant: prove per-repo access via an authorize round-trip,
      // then retry the connect EXACTLY ONCE with the resulting grant. This MUST
      // come before the generic error display so users can authorize the repository.
      const grant = await runGithubConnectAuthorize(
        client,
        installation.installation_id,
        repoFullName,
      );
      try {
        connection = await attemptConnect({
          connectGrant: grant.connectGrant,
          codeVerifier: grant.codeVerifier,
        });
      } catch (retryErr) {
        if (
          retryErr instanceof PlatformApiError &&
          retryErr.status === 403 &&
          retryErr.code === 'invalid connect grant'
        ) {
          // A fresh grant should be accepted; this code means it was rejected
          // (expired, or the browser identity differs from the linked one). Do
          // NOT fall through to the generic 403 "no project access" message.
          log.error(
            'connect: GitHub authorization failed or expired. Run `void github connect` again.',
          );
          process.exit(1);
        }
        throw retryErr;
      }
    } else {
      const message = describeGithubClientError(err, describeConnectError);
      if (message !== null) {
        log.error(`connect: ${message}`);
        process.exit(1);
      }
      throw err;
    }
  }

  // Fail closed when a custom workflow path (from --workflow or the prompt) was
  // not applied. An older platform that predates workflow_path silently drops
  // the field and returns success while staying pinned to the default, so the
  // user would wrongly believe their custom workflow is authorized to deploy.
  // Verify the server echoed it back. (Accepting the default leaves workflowPath
  // undefined, so this check is skipped — see step 6.)
  if (workflowPath !== undefined && connection.workflow_path !== workflowPath) {
    log.error(
      `connect: server did not apply workflow path ${workflowPath} (got ${connection.workflow_path ?? 'none'}). The platform may be too old to support a custom workflow path.`,
    );
    process.exit(1);
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
  if (
    !isTTY &&
    args.branch === undefined &&
    args.executor === undefined &&
    args.workflowPath === undefined
  ) {
    log.error(
      'update: Nothing to update. Pass --branch <name>, --executor <container|github_actions>, and/or --workflow <.github/workflows/...>.',
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
      const message = describeGithubClientError(err, describeUpdateError);
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
  // Effective workflow path — the flag wins; a github_actions TTY prompt (below)
  // can override it; otherwise it stays the current value (no change).
  let workflowPath = args.workflowPath ?? current.workflow_path;

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

    // Prompt for the deploy workflow file when the resulting executor is
    // github_actions and --workflow was not passed. Defaults to the current
    // path; container builds never read workflow_path so there is nothing to ask.
    if (executor === 'github_actions' && args.workflowPath === undefined) {
      const input = await text({
        message: 'Deploy workflow file:',
        placeholder: current.workflow_path,
        initialValue: current.workflow_path,
        validate(value) {
          const v = (value ?? '').trim();
          if (v.length === 0 || isValidWorkflowPath(v)) {
            return;
          }
          return 'Must be under .github/workflows/, end in .yml/.yaml, and not contain "..".';
        },
      });
      if (isCancel(input)) {
        cancel('Cancelled.');
        process.exit(0);
      }
      workflowPath = (input as string).trim() || current.workflow_path;
    }
  } else {
    // The missing-flags guard at the top of this function already guaranteed at
    // least one of --branch / --executor / --workflow is present in non-TTY mode.
    branch = args.branch ?? current.branch;
    executor = args.executor ?? current.build_executor;
  }

  // -------------------------------------------------------------------------
  // 4. Build a patch carrying ONLY the fields that actually changed.
  // -------------------------------------------------------------------------
  const patch: {
    branch?: string;
    buildExecutor?: 'container' | 'github_actions';
    workflowPath?: string;
  } = {};
  if (branch !== current.branch) {
    patch.branch = branch;
  }
  if (executor !== current.build_executor) {
    patch.buildExecutor = executor;
  }
  // Change workflow_path only when the effective value (from --workflow or the
  // github_actions prompt above) differs from the stored value. Accepting the
  // current value at the prompt leaves it unchanged, so nothing is sent.
  if (workflowPath !== current.workflow_path) {
    patch.workflowPath = workflowPath;
  }

  // -------------------------------------------------------------------------
  // 5. No-op guard — never hit the API when nothing changed.
  // -------------------------------------------------------------------------
  if (
    patch.branch === undefined &&
    patch.buildExecutor === undefined &&
    patch.workflowPath === undefined
  ) {
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
      const message = describeGithubClientError(err, describeUpdateError);
      if (message !== null) {
        log.error(`update: ${message}`);
        process.exit(1);
      }
      throw err;
    }
    throw err;
  }

  // Fail closed when a custom workflow path (from --workflow or the prompt) was
  // not applied — same old-platform compatibility hazard as connect: the server
  // could return success while ignoring the unknown field, leaving the workflow
  // pin unchanged.
  if (patch.workflowPath !== undefined && updated.workflow_path !== patch.workflowPath) {
    log.error(
      `update: server did not apply workflow path ${patch.workflowPath} (got ${updated.workflow_path ?? 'none'}). The platform may be too old to support a custom workflow path.`,
    );
    process.exit(1);
  }

  log.success(
    `Updated ${updated.repo_full_name} → branch ${updated.branch}, executor ${updated.build_executor}, workflow ${updated.workflow_path}.`,
  );
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/**
 * `void github status [project]` — print the current GitHub connection (repo,
 * branch, build executor, deploy workflow). Read-only; never mutates. Project
 * resolution mirrors connect/update; a 404 means the project was never
 * connected and points the user at `connect`.
 */
export async function runStatus(
  root: string,
  client: PlatformClient,
  args: Extract<GithubArgs, { subcommand: 'status' }>,
): Promise<void> {
  const isTTY = process.stdin.isTTY === true;

  // -------------------------------------------------------------------------
  // 1. Resolve project (identical resolution order to connect/update).
  // -------------------------------------------------------------------------
  let projectId: string;

  const requestedSlug = getRequestedProjectSlug({ projectSlug: args.projectName || undefined });

  if (requestedSlug) {
    const projects = await client.listProjects();
    const resolved = resolveProjectBySlug(projects, requestedSlug);
    if (!resolved) {
      log.error(`status: No project found with slug '${requestedSlug}'.`);
      process.exit(1);
    }
    projectId = resolved.projectId;
  } else {
    const linked = readProjectConfig(root);
    if (linked) {
      projectId = linked.projectId;
    } else if (!isTTY) {
      log.error(
        'status: No project specified. Pass a project name or --project <name>, set VOID_PROJECT, or link one with `void project link`.',
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
  // 2. Fetch and display the connection. A missing connection (404) means the
  //    project was never connected — reuse the update 404 mapping to point the
  //    user at `connect` instead of a raw error.
  // -------------------------------------------------------------------------
  let connection: GithubConnection;
  try {
    connection = await client.getGithubConnection(projectId);
  } catch (err) {
    if (err instanceof PlatformApiError) {
      const message = describeGithubClientError(err, describeUpdateError);
      if (message !== null) {
        log.error(`status: ${message}`);
        process.exit(1);
      }
    }
    throw err;
  }

  log.message(formatConnection(connection));
}

// ---------------------------------------------------------------------------
// disconnect
// ---------------------------------------------------------------------------

/**
 * `void github disconnect [project]` — remove a project's GitHub connection so
 * pushes no longer auto-deploy. The server (DELETE /projects/:id/github)
 * terminalizes any in-flight builds (revoking their deploy tokens) before
 * dropping the connection row. Destructive, so a TTY run confirms first; --yes
 * skips the prompt and is REQUIRED in a non-interactive shell. A project with no
 * connection is already in the goal state — report it and exit 0.
 */
export async function runGithubDisconnect(
  root: string,
  client: PlatformClient,
  args: Extract<GithubArgs, { subcommand: 'disconnect' }>,
): Promise<void> {
  const isTTY = process.stdin.isTTY === true;

  // -------------------------------------------------------------------------
  // 1. Resolve project (identical resolution order to connect/update/status).
  // -------------------------------------------------------------------------
  let projectId: string;

  const requestedSlug = getRequestedProjectSlug({ projectSlug: args.projectName || undefined });

  if (requestedSlug) {
    const projects = await client.listProjects();
    const resolved = resolveProjectBySlug(projects, requestedSlug);
    if (!resolved) {
      log.error(`disconnect: No project found with slug '${requestedSlug}'.`);
      process.exit(1);
    }
    projectId = resolved.projectId;
  } else {
    const linked = readProjectConfig(root);
    if (linked) {
      projectId = linked.projectId;
    } else if (!isTTY) {
      log.error(
        'disconnect: No project specified. Pass a project name or --project <name>, set VOID_PROJECT, or link one with `void project link`.',
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
  // 2. Fetch the current connection. A 404 "connection not found" means the
  //    project already has no connection — disconnect's goal state — so report
  //    success and stop. Other errors (403 forbidden, 404 project not found)
  //    map through the shared connect error strings and exit 1.
  // -------------------------------------------------------------------------
  let connection: GithubConnection;
  try {
    connection = await client.getGithubConnection(projectId);
  } catch (err) {
    if (err instanceof PlatformApiError) {
      const body = parsePlatformErrorBody(err.body);
      const code = body?.error ?? body?.message ?? '';
      if (err.status === 404 && code.includes('connection not found')) {
        log.info('This project is not connected to a GitHub repository. Nothing to disconnect.');
        return;
      }
      const message = describeGithubClientError(err, describeConnectError);
      if (message !== null) {
        log.error(`disconnect: ${message}`);
        process.exit(1);
      }
    }
    throw err;
  }

  // -------------------------------------------------------------------------
  // 3. Confirm — this cancels in-flight builds and drops the connection. --yes
  //    skips the prompt; a non-interactive shell has nothing to prompt, so it
  //    must pass --yes (fail closed, same posture as connect/update).
  // -------------------------------------------------------------------------
  if (!args.yes) {
    if (!isTTY) {
      log.error(
        'disconnect: Refusing to disconnect without confirmation in a non-interactive shell. Re-run with --yes.',
      );
      process.exit(1);
    }
    const ok = await confirm({
      message: `Disconnect ${connection.repo_full_name} from this project? This cancels any in-flight builds.`,
      initialValue: false,
    });
    if (isCancel(ok)) {
      cancel('Cancelled.');
      process.exit(0);
    }
    if (!ok) {
      log.info('Disconnect cancelled.');
      return;
    }
  }

  // -------------------------------------------------------------------------
  // 4. Disconnect.
  // -------------------------------------------------------------------------
  try {
    await client.deleteGithubConnection(projectId);
  } catch (err) {
    if (err instanceof PlatformApiError) {
      const message = describeGithubClientError(err, describeConnectError);
      if (message !== null) {
        log.error(`disconnect: ${message}`);
        process.exit(1);
      }
    }
    throw err;
  }

  log.success(`Disconnected ${connection.repo_full_name}.`);
}
