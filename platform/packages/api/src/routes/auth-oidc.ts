import { Hono } from 'hono';
import { deployTokenTtlSecondsForBuildMinutes, signDeployToken } from '../auth/deploy-token.ts';
import {
  createGithubActionsBuildWithinLimit,
  getGitHubActionsConnectionsByRepo,
  getUser,
  markBuildTerminalIfActive,
  setBuildCheckRunId,
} from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { VOID_BUILD_CHECK_RUN_NAME, createCheckRun } from '../github/check-run.ts';
import {
  getBranchHeadComparisonStatus,
  getRepoInstallation,
} from '../github/installation-token.ts';
import { verifyGithubOidcToken } from '../github/oidc-verify.ts';
import { resolvePlanLimits } from '../plans.ts';
import { PROJECT_PERMISSION_MESSAGES } from '../project-access.ts';
import { isAdminSuspended } from '../suspension.ts';

const app = new Hono<ApiEnv>();

// Only trusted, write-access-gated trigger events may mint a deploy token.
// `push` is the scaffolded trigger; `workflow_dispatch` is a collaborator-only
// manual run. PR-family events (`pull_request`, `pull_request_target`) are
// rejected: `pull_request_target` runs in the BASE context (so its sha == the
// connected branch head and the freshness gate would PASS) yet can check out
// untrusted PR-head code. `event_name` is a standard, always-minted GitHub
// Actions OIDC claim, so requiring it never false-rejects a legit push.
const ALLOWED_OIDC_EVENTS = new Set(['push', 'workflow_dispatch']);

// GitHub's `workflow_ref` / `job_workflow_ref` claims are formatted
// `OWNER/REPO/PATH/TO/workflow.yml@REF` (e.g.
// `octo/repo/.github/workflows/void-deploy.yml@refs/heads/main`). Returns the
// workflow file PATH (the part between the `OWNER/REPO/` prefix and the `@REF`
// suffix) when the claim names the given repository, else null. Used to confirm
// the running workflow is the scaffolded `void-deploy.yml` for the connected
// repo rather than some other workflow.
function workflowPathForRepo(workflowRef: string, repository: string): string | null {
  const prefix = `${repository}/`;
  if (!workflowRef.startsWith(prefix)) {
    return null;
  }
  const afterRepo = workflowRef.slice(prefix.length);
  const at = afterRepo.lastIndexOf('@');
  return at === -1 ? afterRepo : afterRepo.slice(0, at);
}

// POST /auth/github-oidc — GitHub Actions OIDC token exchange. PUBLIC: the
// OIDC token (verified against GitHub's JWKS) is the authentication.
//
// Request body:  { oidcToken: string, project: string }   (project = slug)
// Response 200:  { token: string, projectId: string }
//   - `token` is a project-scoped deploy token (aud:'deploy') whose TTL is
//     sized to the owner's plan build timeout + margin (so a long build can't
//     expire it mid-deploy). The workflow exports it as VOID_TOKEN and runs
//     `void deploy --project <slug>`.
// Errors:
//   503 { error } — GitHub App not configured in this environment.
//   400 { error } — missing/invalid body.
//   401 { error } — OIDC token invalid/expired, or no usable connection.
//
// Returns 503 (inert) when GitHub App secrets are unset so the endpoint is
// safe to mount in prod before the App exists.
app.post('/github-oidc', async (context) => {
  if (
    typeof context.env.GITHUB_APP_ID !== 'string' ||
    context.env.GITHUB_APP_ID === '' ||
    typeof context.env.GITHUB_APP_PRIVATE_KEY !== 'string' ||
    context.env.GITHUB_APP_PRIVATE_KEY === ''
  ) {
    return context.json({ error: 'github app not configured' }, 503);
  }

  let body: { oidcToken?: unknown; project?: unknown };
  try {
    body = await context.req.json<{ oidcToken?: unknown; project?: unknown }>();
  } catch {
    return context.json({ error: 'invalid body' }, 400);
  }

  if (typeof body.oidcToken !== 'string' || body.oidcToken === '') {
    return context.json({ error: 'oidcToken is required' }, 400);
  }
  const projectSlug = typeof body.project === 'string' ? body.project : undefined;

  // The scaffolded workflow requests audience `void` (see the CLI's GitHub
  // Actions workflow). Enforce it so a token minted for some other audience
  // can't be replayed here.
  const claims = await verifyGithubOidcToken(body.oidcToken, { audience: 'void' });
  if (!claims) {
    return context.json({ error: 'invalid or expired oidc token' }, 401);
  }

  // The claims we rely on for routing/identity must be present non-empty
  // strings. GitHub always mints these for an Actions OIDC token; a token
  // missing them is malformed and must not authorize a deploy.
  if (typeof claims.repository_id !== 'string' || claims.repository_id === '') {
    return context.json({ error: 'oidc token missing repository_id' }, 401);
  }
  if (typeof claims.repository_owner_id !== 'string' || claims.repository_owner_id === '') {
    return context.json({ error: 'oidc token missing repository_owner_id' }, 401);
  }
  if (typeof claims.run_attempt !== 'string' || claims.run_attempt === '') {
    return context.json({ error: 'oidc token missing run_attempt' }, 401);
  }
  const workflowRef =
    typeof claims.job_workflow_ref === 'string' && claims.job_workflow_ref !== ''
      ? claims.job_workflow_ref
      : claims.workflow_ref;
  if (typeof workflowRef !== 'string' || workflowRef === '') {
    return context.json({ error: 'oidc token missing workflow_ref' }, 401);
  }

  // Only an allowlisted trigger event may mint a deploy token (see
  // ALLOWED_OIDC_EVENTS). Rejects PR-family events whose BASE-context claims
  // would otherwise pass the branch + freshness gates before any DB/GitHub work.
  if (typeof claims.event_name !== 'string' || !ALLOWED_OIDC_EVENTS.has(claims.event_name)) {
    return context.json({ error: 'oidc token event is not an allowed deploy trigger' }, 401);
  }

  const db = context.get('db');
  const connections = await getGitHubActionsConnectionsByRepo(
    db,
    claims.repository_id,
    claims.repository_owner_id,
  );
  if (connections.length === 0) {
    return context.json(
      { error: 'no authorized github actions connection for repository; reconnect the repository' },
      401,
    );
  }

  // A repo may back multiple github_actions projects. When the workflow declares
  // a target slug, select THAT project's connection (prevents a repo's OIDC token
  // from minting a token for a different project, and lets an older project still
  // deploy instead of always losing to the newest connection). With no slug, the
  // repo must map to exactly one project, else the request is ambiguous.
  let connection;
  if (projectSlug !== undefined) {
    connection = connections.find((c) => c.project_slug === projectSlug);
    if (!connection) {
      return context.json({ error: 'project does not match connection' }, 401);
    }
  } else if (connections.length === 1) {
    connection = connections[0];
  } else {
    return context.json(
      { error: 'multiple projects connected to repository; specify --project' },
      401,
    );
  }

  // Defense in depth: the helper already filters on build_executor, but assert it
  // here so a future query change can't silently authorize a container connection
  // through the OIDC path.
  if (connection.build_executor !== 'github_actions') {
    return context.json({ error: 'connection is not configured for github actions' }, 401);
  }

  // Bind the deploy token to the connection's authorized workflow file
  // (project-configured `workflow_path`, default `.github/workflows/void-deploy.yml`
  // as scaffolded by `void init --github`). The running workflow file must equal
  // that path under the OIDC token's OWN repository, so any OTHER workflow in the
  // repo that can request `id-token: write` (a hand-added workflow, an unsafe
  // `pull_request_target`) can't act as a deploy oracle. `workflowPathForRepo`
  // matches against `claims.repository` and returns null on a prefix mismatch
  // (which never equals the stored path), so the path can't be spoofed via a
  // different repo prefix. Checked AFTER connection selection so each connection
  // pins its own workflow; a rejected request costs one indexed SELECT (the JWT
  // is already verified and keyed on the verified repo id).
  const tokenWorkflowPath = workflowPathForRepo(workflowRef, claims.repository);
  if (tokenWorkflowPath !== connection.workflow_path) {
    return context.json({ error: 'oidc token is not from the void deploy workflow' }, 401);
  }

  const user = await getUser(db, connection.user_id);
  if (!user) {
    return context.json({ error: 'connection owner not found' }, 401);
  }
  if (isAdminSuspended(user.suspended_reason)) {
    return context.json(
      { error: 'project owner suspended', message: PROJECT_PERMISSION_MESSAGES['owner-suspended'] },
      403,
    );
  }

  // Only branch pushes to the connected branch may mint a deploy token. This
  // mirrors the webhook push guard (`branch !== connection.branch`) and rejects
  // tag/PR refs (`refs/tags/*`, `refs/pull/*`) outright.
  //
  // verifyGithubOidcToken validates the signature but not claim TYPES, so a
  // signed-but-malformed token may carry a missing/non-string `ref`. Guard it
  // before `.startsWith`/`.slice` so it returns the controlled 401 used for
  // every other malformed claim rather than throwing into a global 500.
  if (typeof claims.ref !== 'string' || claims.ref === '') {
    return context.json({ error: 'oidc token missing ref' }, 401);
  }
  if (!claims.ref.startsWith('refs/heads/')) {
    return context.json({ error: 'oidc ref is not a branch' }, 401);
  }
  const branch = claims.ref.slice('refs/heads/'.length);
  if (branch !== connection.branch) {
    return context.json({ error: 'oidc ref does not match connected branch' }, 401);
  }

  // Fail-closed stale-SHA guard for the auto-deploy path. Proceed ONLY when the
  // branch head IS claims.sha ('identical'). Otherwise reject BEFORE
  // createGithubActionsBuildWithinLimit supersedes the newer active build + mints
  // a token: 'ahead' = branch head is ahead of sha (sha is stale), 'behind' =
  // branch head no longer contains sha (the branch was moved BACKWARD off sha via
  // force-push/rollback, so sha is an abandoned commit), 'diverged' = sha is
  // off-branch (force-pushed away), null = the compare API was unreachable so we
  // cannot prove freshness. Failing open here would let an older/abandoned run
  // roll the project back during a GitHub API outage; the workflow runs on GitHub
  // anyway, so blocking on a GitHub outage is acceptable. null is checked first so
  // the unverifiable case stays retryable (503) rather than a hard 409.
  const headComparison = await getBranchHeadComparisonStatus(
    context.env,
    connection.installation_id,
    claims.repository,
    claims.sha,
    branch,
  );
  if (headComparison === null) {
    return context.json({ error: 'unable to verify branch head; retry' }, 503);
  }
  if (headComparison !== 'identical') {
    return context.json({ error: 'oidc sha is not the current branch head' }, 409);
  }

  // Fail-closed live revocation check. The GitHub Actions path mints no
  // installation token, so a missed/delayed installation / suspend /
  // installation_repositories webhook can leave the cached `github_installations`
  // state granting access after the App was removed/suspended on the repo. One
  // lightweight App-JWT call against GitHub confirms the App STILL covers the
  // repo before any build row is created (deploys take minutes, so ~200ms is
  // fine). Complements — does not replace — the cached `account_id ===
  // repository_owner_id` check already in `getGitHubActionsConnectionsByRepo`.
  const liveInstall = await getRepoInstallation(context.env, claims.repository);
  if (!liveInstall) {
    return context.json({ error: 'github app is not installed on this repository' }, 401);
  }
  if (liveInstall.installationId !== connection.installation_id) {
    return context.json({ error: 'repository is not covered by this installation' }, 401);
  }
  if (liveInstall.accountId !== claims.repository_owner_id) {
    return context.json({ error: 'repository owner does not match installation' }, 401);
  }

  // Acquire the build slot and create the `building` row atomically. A workflow
  // may re-request the OIDC token (step retry, rerun of the same run); the
  // helper reuses the existing in-flight build for this exact run instead of
  // inserting a duplicate, so stale rows don't pile up `building` forever (the
  // workflow_run webhook only finalizes the active/newest match) silently
  // consuming the owner's active-build concurrency slots.
  //
  // The owner's per-tier build concurrency (`concurrentBuilds`, 0 = unlimited)
  // is enforced inside the same transaction under a per-user FOR UPDATE lock so
  // parallel exchanges for DIFFERENT runs can't each read capacity below the
  // cap and all insert — GitHub Actions builds occupy an active-build slot
  // (status `building`) just like container builds. Build identity is scoped to
  // the project because a GitHub `run_id` is unique only WITHIN a repository,
  // not globally; the composite partial-unique index (migration 0021) backstops
  // the same-run race at the DB layer while still allowing a rerun once the
  // prior attempt is terminal.
  const githubRunId = String(claims.run_id);
  // A RERUN reuses the same run_id with an incremented run_attempt; persist it
  // so the workflow_run completion handler can finalize the RIGHT attempt's
  // build.
  const githubRunAttempt = claims.run_attempt;
  const result = await createGithubActionsBuildWithinLimit(db, {
    projectId: connection.project_id,
    commitSha: claims.sha,
    branch,
    githubRunId,
    githubRunAttempt,
    logsUrl: `https://github.com/${claims.repository}/actions/runs/${claims.run_id}`,
    connectionId: connection.id,
    installationId: connection.installation_id,
    repositoryId: connection.repository_id,
    // tokenWorkflowPath is non-null here: it passed the `!== connection.workflow_path`
    // gate above against a NOT NULL column, so it equals the snapshot pin. Re-checked
    // under the row lock so a concurrent workflow_path PATCH fails this exchange closed.
    expectedWorkflowPath: tokenWorkflowPath,
  });
  if (result.outcome === 'limit-exceeded') {
    return context.json({ error: 'concurrent build limit reached' }, 429);
  }
  if (result.outcome === 'install-revoked') {
    // A revocation (App suspend/uninstall or repo removal) committed between the
    // resolver/live-install checks and this tx; do not mint a token for a repo
    // the App no longer covers. 401 matches the route's other live-install rejects.
    return context.json({ error: 'github app is no longer installed on this repository' }, 401);
  }
  if (result.outcome === 'connection-removed') {
    // The connection was disconnected concurrently with this exchange; do not
    // mint a token for a repo that is no longer connected.
    return context.json({ error: 'github connection was removed' }, 409);
  }
  if (result.outcome === 'connection-replaced') {
    // The connection was disconnected and reconnected to a DIFFERENT repo between
    // resolution and this tx (same branch/executor, fresh id); do not mint a token
    // for a project now bound to a different repo. 409: a concurrent config change.
    return context.json({ error: 'github connection was replaced' }, 409);
  }
  if (result.outcome === 'branch-mismatch') {
    return context.json({ error: 'connected branch changed concurrently' }, 409);
  }
  if (result.outcome === 'workflow-mismatch') {
    // The workflow_path was re-pinned between the pre-tx gate and this locked
    // re-read; the token's workflow is no longer the authorized one. Do not mint.
    // 409: a concurrent config change, same class as branch-mismatch above.
    return context.json({ error: 'authorized workflow changed concurrently' }, 409);
  }
  if (result.outcome === 'project-deleting') {
    // The project is being torn down (or already gone) concurrently with this
    // exchange; do not mint a deploy token for a deleting project. 409: a
    // concurrent lifecycle change, same class as the other concurrency rejects.
    return context.json({ error: 'project is being deleted' }, 409);
  }
  if (result.outcome === 'owner-suspended') {
    return context.json(
      { error: 'project owner suspended', message: PROJECT_PERMISSION_MESSAGES['owner-suspended'] },
      403,
    );
  }
  const build = result.build;
  // The build helper re-reads and locks the project, so `build.user_id` is the
  // billing owner that was current at admission even if ownership changed after
  // the earlier connection lookup. Use that authoritative owner for token
  // identity and timeout sizing.
  const billingOwner = await getUser(db, build.user_id);
  if (!billingOwner) {
    await markBuildTerminalIfActive(db, build.id, 'cancelled', {
      error: 'project owner no longer exists',
      completedAt: new Date().toISOString(),
    });
    return context.json({ error: 'connection owner not found' }, 401);
  }

  // Post-create freshness re-check, closing the compare→insert TOCTOU: a newer
  // push landing between the pre-check above and the build INSERT is invisible
  // to the push webhook's `terminateBuildsForProject` cleanup (it no-ops when
  // the row doesn't exist yet), so without this the stale run would keep an
  // ACTIVE build — and a live build-bound deploy token — for a superseded
  // commit. Now that the row is committed, re-prove the sha is STILL the branch
  // head before minting; on any non-'identical' verdict (null included),
  // CAS-terminalize the row ourselves. Terminalizing on null matters: an
  // orphaned active row would hold a concurrency slot until the reaper, and a
  // retried exchange re-inserts cleanly (the partial-unique index covers only
  // ACTIVE statuses; the idempotent-reuse lookup skips terminal rows). The CAS
  // preserves a concurrent terminalizer's outcome. A push AFTER this re-check
  // whose webhook is missed remains the documented TTL-bounded limitation.
  const headRecheck = await getBranchHeadComparisonStatus(
    context.env,
    connection.installation_id,
    claims.repository,
    claims.sha,
    branch,
  );
  if (headRecheck !== 'identical') {
    await markBuildTerminalIfActive(db, build.id, 'cancelled', {
      error: 'superseded by newer push during token exchange',
      completedAt: new Date().toISOString(),
    });
    if (headRecheck === null) {
      // Mirror the pre-check's null stance: unverifiable is retryable, not a
      // hard reject (the cancelled row above does not block the retry).
      return context.json({ error: 'unable to verify branch head; retry' }, 503);
    }
    return context.json({ error: 'oidc sha is not the current branch head' }, 409);
  }

  // Best-effort: create the executor-agnostic "Void Build" GitHub Check Run so
  // the github_actions path reports deploy status on the commit — mirroring the
  // container path (which creates it inside the BuildManager DO). Placed AFTER
  // the post-create freshness re-check so the cancel-and-return branch above can
  // never strand a run `in_progress`: past this point the build WILL proceed
  // (the token is minted next). The Actions executor has no DO, so this is the
  // only place to create the run; the `workflow_run:completed` webhook finalizes
  // it.
  //
  // Kept SYNCHRONOUS (awaited before the token is minted below) on purpose: the
  // create + persist must be durable before the deploy proceeds. Deferring it via
  // `waitUntil` would (a) let a rapid repeated exchange for the same run read the
  // reused row while `check_run_id` is still null — the first exchange's deferred
  // persist not yet committed — and POST a DUPLICATE check, defeating the guard
  // below; and (b) open a window where `workflow_run:completed` arrives before the
  // id is persisted, so the webhook sees null and never completes the run (a new
  // stuck-`in_progress` class). Awaiting closes both. The added latency is bounded
  // (the exchange already makes several GitHub round-trips) and best-effort: a
  // check-run failure MUST NOT fail the OIDC exchange — `createCheckRun` swallows
  // its own errors and returns null, but the block is wrapped defensively so a
  // throw (e.g. from `setBuildCheckRunId`) is logged rather than surfaced.
  //
  // Guarded on `!build.check_run_id`: a repeated exchange for the SAME (project,
  // run, attempt) while the build is still active reuses the in-flight row
  // (`result.outcome === 'reused'`), which already carries the check_run_id
  // its creating exchange persisted. Creating
  // again would POST a SECOND "Void Build" run and overwrite the id, orphaning the
  // first `in_progress` forever. A reused build whose earlier create FAILED still
  // has a null id, so a retry is allowed and cannot duplicate.
  //
  // Residual (bounded, cosmetic): two TRULY CONCURRENT exchanges for the same
  // (project, run, attempt) can both read a null id inside this create+persist
  // window and both POST — a duplicate check, one left `in_progress`. That needs
  // parallel `void deploy` runs in the SAME run+attempt (a single deploy exchanges
  // once; a re-run gets a new attempt → a new row/check; CLI retries are
  // sequential → already closed by the sync guard), so it is a pathological-
  // workflow case with no deploy/security impact. `setBuildCheckRunId` is CAS
  // `check_run_id IS NULL` (immutable once set), so the DB still keeps ONE stable,
  // completion-tracked id rather than clobbering.
  if (!build.check_run_id) {
    try {
      const checkRunId = await createCheckRun(
        context.env,
        connection.installation_id,
        claims.repository,
        {
          name: VOID_BUILD_CHECK_RUN_NAME,
          headSha: claims.sha,
          externalId: build.id,
          // The GitHub Actions run page is this build's real details view (the
          // Actions executor has no DO log store — it links out to the run), so
          // point `details_url` there rather than the project's public URL the
          // container path uses. `build.logs_url` is the same run URL the webhook
          // completion reads, so create and complete stay consistent.
          detailsUrl: build.logs_url ?? undefined,
          title: 'Void deploy in progress',
          summary: `Deploying \`${branch}\` @ ${claims.sha.slice(0, 7)} via GitHub Actions`,
        },
      );
      if (checkRunId) {
        await setBuildCheckRunId(db, build.id, checkRunId);
      }
    } catch (err) {
      console.warn('[auth-oidc] best-effort check-run create failed', err);
    }
  }

  // Size the token to cover the whole workflow (it is exchanged BEFORE
  // install + build + upload + finalize), since some tiers allow builds longer
  // than the 15-min default (e.g. sponsored buildTimeoutMinutes=20). Mirrors
  // the container path's TTL sizing via the shared helper.
  const token = await signDeployToken(
    {
      projectId: connection.project_id,
      userId: build.user_id,
      login: billingOwner.login,
      buildId: build.id,
    },
    context.env.JWT_SECRET,
    {
      ttlSeconds: deployTokenTtlSecondsForBuildMinutes(
        result.outcome === 'created'
          ? result.timeoutMinutes
          : (await resolvePlanLimits(db, billingOwner.plan)).buildTimeoutMinutes,
      ),
    },
  );

  return context.json({ token, projectId: connection.project_id, buildId: build.id });
});

export const oidcRoutes = app;
