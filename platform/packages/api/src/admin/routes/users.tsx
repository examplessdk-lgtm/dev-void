import { Hono } from 'hono';
import {
  getAllUsers,
  countUsers,
  searchUsers,
  getUser,
  getProjectsByUserId,
  updateUserPlan,
  suspendUser,
  unsuspendUser,
  unsuspendUserIfReason,
  countUserDeploymentsToday,
  deleteUser,
} from '../../db.ts';
import type { ApiEnv } from '../../env.ts';
import { teardownProject } from '../../provisioning/cleanup.ts';
import { getRequestsDataset, queryBatchProjectUsage, ZERO_USAGE } from '../../routes/usage.ts';
import {
  refreshProjectKvForUser,
  sandboxBlockKey,
  setProjectsRoutingSuspension,
} from '../../routing.ts';
import {
  isAdminSuspended,
  REASON_REQUESTS_EXCEEDED,
  REASON_SANDBOX_RUNTIME_EXCEEDED,
} from '../../suspension.ts';
import { PLAN_LIMITS, getCurrentBillingPeriodStart, type PlanId } from '../../tiers.ts';
import { UserDetailPage } from '../views/user-detail.tsx';
import { UsersListPage } from '../views/users-list.tsx';

const PAGE_SIZE = 20;
const app = new Hono<ApiEnv>();

// GET /users
app.get('/', async (context) => {
  const search = context.req.query('search');
  if (search) {
    const users = await searchUsers(context.get('db'), search);
    return context.html(
      <UsersListPage users={users} search={search} username={context.get('user').login} />,
    );
  }
  const page = Math.max(1, parseInt(context.req.query('page') ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const [users, total] = await Promise.all([
    getAllUsers(context.get('db'), PAGE_SIZE, offset),
    countUsers(context.get('db')),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return context.html(
    <UsersListPage
      users={users}
      page={page}
      totalPages={totalPages}
      username={context.get('user').login}
    />,
  );
});

// GET /users/:id
app.get('/:id', async (context) => {
  const user = await getUser(context.get('db'), context.req.param('id'));
  if (!user) {
    return context.html('<h1>User not found</h1>', 404);
  }
  const [projects, deploysToday] = await Promise.all([
    getProjectsByUserId(context.get('db'), user.id),
    countUserDeploymentsToday(context.get('db'), user.id),
  ]);

  const since = user.billing_cycle_start
    ? getCurrentBillingPeriodStart(user.billing_cycle_start)
    : new Date();
  const usageMap = await queryBatchProjectUsage(
    context.env.CF_ACCOUNT_ID,
    context.env.CF_API_TOKEN,
    getRequestsDataset(context.env),
    projects.map((p) => p.id),
    since,
  );
  const projectUsages = projects.map((p) => ({
    projectId: p.id,
    slug: p.slug,
    ...(usageMap.get(p.id) ?? ZERO_USAGE),
  }));
  const totalRequests = projectUsages.reduce((sum, u) => sum + u.requests, 0);
  const totalBandwidth = projectUsages.reduce((sum, u) => sum + u.bandwidthBytes, 0);

  return context.html(
    <UserDetailPage
      user={user}
      projects={projects}
      deploysToday={deploysToday}
      usage={{
        billingPeriodStart: since.toISOString(),
        totalRequests,
        totalBandwidth,
        projects: projectUsages,
      }}
      username={context.get('user').login}
    />,
  );
});

// POST /users/:id/plan
app.post('/:id/plan', async (context) => {
  const user = await getUser(context.get('db'), context.req.param('id'));
  if (!user) {
    return context.html('<h1>User not found</h1>', 404);
  }
  const body = await context.req.parseBody();
  const plan = body.plan as string;
  if (!plan || !(plan in PLAN_LIMITS)) {
    return context.html('<h1>Invalid plan</h1>', 400);
  }
  const newPlan = plan as PlanId;
  await updateUserPlan(context.get('db'), user.id, newPlan);
  // Optimistic clear: a plan change can lift the request OR runtime-budget cap,
  // so drop BOTH usage suspensions now; the next handleRecord re-suspends if
  // usage is still over the new limit. Request suspension must be cleared here
  // too: the scheduled reconcile skips unlimited plans, so a capped→unlimited
  // upgrade would otherwise strand the user at 429 forever. Reason-scoped
  // (`matchReason: requests_exceeded`) so a plan change never lifts an admin
  // suspension. `/reevaluate-sandbox` drops all DO usage latches (request +
  // sandbox + AI) and deletes the projectId-keyed ai-block keys.
  //
  // The plan is already persisted; surface a cleanup failure (incl. a non-2xx
  // DO response) instead of redirecting green, because the unlimited-plan
  // request/AI cleanup does not self-heal via the scheduled reconcile. The plan
  // form is always available, so retrying re-runs the idempotent cleanup.
  try {
    const projects = await getProjectsByUserId(context.get('db'), user.id);
    const stub = context.env.USAGE_COUNTER.get(context.env.USAGE_COUNTER.idFromName(user.id));
    const [, , , , , reevalRes] = await Promise.all([
      refreshProjectKvForUser(context.get('db'), context.env.ROUTING, user.id),
      setProjectsRoutingSuspension(context.env.ROUTING, context.get('db'), projects, {
        op: 'unsuspend',
        matchReason: REASON_REQUESTS_EXCEEDED,
      }),
      context.env.ROUTING.delete(sandboxBlockKey(user.id)),
      unsuspendUserIfReason(context.get('db'), user.id, REASON_REQUESTS_EXCEEDED),
      unsuspendUserIfReason(context.get('db'), user.id, REASON_SANDBOX_RUNTIME_EXCEEDED),
      stub.fetch(
        new Request('https://do/reevaluate-sandbox', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: newPlan }),
        }),
      ),
    ]);
    if (!reevalRes.ok) {
      throw new Error(`reevaluate-sandbox DO returned HTTP ${reevalRes.status}`);
    }
  } catch (error) {
    console.error('[admin] plan-change cleanup failed', { userId: user.id, error });
    return context.html(
      `<h1>Plan changed, cleanup incomplete</h1><p>The plan is now "${newPlan}", but clearing the ` +
        'old usage suspension state failed. The user may still be blocked. Retry the plan change — ' +
        'the cleanup is idempotent.</p>',
      500,
    );
  }
  return context.redirect(`/admin/users/${user.id}`);
});

// POST /users/:id/suspend
app.post('/:id/suspend', async (context) => {
  const user = await getUser(context.get('db'), context.req.param('id'));
  if (!user) {
    return context.html('<h1>User not found</h1>', 404);
  }
  const body = await context.req.parseBody();
  const reason = (body.reason as string) || 'admin_suspended';
  // Reject the reserved usage-enforcement reasons. They classify as a usage
  // suspension (isAdminSuspended === false), which the scheduled reconcile would
  // auto-clear once the DO request latch is false — silently un-blocking an
  // admin-intended suspension. Admin reasons must stay outside that set.
  if (!isAdminSuspended(reason)) {
    return context.html(
      `<h1>Reserved reason</h1><p>"${reason}" is reserved for automatic usage enforcement and ` +
        'cannot be used for an admin suspension. Use a different reason.</p>',
      400,
    );
  }
  // Stamp edge enforcement FIRST, the DB `suspended_reason` LAST — the mirror of
  // the unsuspend route's cleanup-first/DB-last ordering. Dispatch enforces only
  // `routing.suspended`, so a DB-first ordering that then failed on the KV fan-out
  // would mark the user suspended in the control plane while every unstamped route
  // keeps serving — a fail-OPEN strand — and the detail view (which gates the
  // Unsuspend form on `suspended_reason`) would flip to "suspended" with only an
  // Unsuspend affordance, not a retry of the failed suspend. Stamping KV first
  // means a failure leaves the edge blocked (fail-closed) and the DB still active,
  // so the Suspend form stays and the operator retries the idempotent stamp.
  //
  // Stamp `suspended` on every routing entry dispatch serves the user's projects
  // from — slug AND active `domain:<host>` routes — so a suspended project is
  // blocked on its custom domains too, not just its slug. `force: true`: an admin
  // suspension is authoritative and overwrites any usage-driven `requests_exceeded`
  // marker already on the route.
  try {
    const projects = await getProjectsByUserId(context.get('db'), user.id);
    await setProjectsRoutingSuspension(context.env.ROUTING, context.get('db'), projects, {
      op: 'suspend',
      reason,
      force: true,
    });
    await suspendUser(context.get('db'), user.id, reason);
  } catch (error) {
    console.error('[admin] suspend failed', { userId: user.id, error });
    return context.html(
      '<h1>Suspend incomplete</h1><p>Edge enforcement could not be fully stamped, so the user ' +
        'was not marked suspended. Retry the suspend — the stamp is idempotent.</p>',
      500,
    );
  }

  return context.redirect(`/admin/users/${user.id}`);
});

// POST /users/:id/unsuspend
app.post('/:id/unsuspend', async (context) => {
  const user = await getUser(context.get('db'), context.req.param('id'));
  if (!user) {
    return context.html('<h1>User not found</h1>', 404);
  }
  // Clear every piece of usage-suspension state, not just the slug route:
  //  - `suspended` on slug + every `domain:<host>` route (dispatch 429)
  //  - sandbox-block KV (proxy 409 on /sandbox/acquire)
  //  - the UsageCounter DO request/sandbox latches, so the next billing
  //    reconcile `/init` does not re-stamp the routes we just cleared.
  //
  // Edge enforcement is cleared FIRST; the DB `suspended_reason` is cleared LAST
  // and only if all of it succeeded. Rationale: the scheduled reconcile only
  // self-heals `requests_exceeded`, so a stale admin/custom marker left here
  // would 429 the user indefinitely. If we cleared the DB first and cleanup then
  // failed, the user-detail view (which shows the Unsuspend form only while
  // `suspended_reason` is set) would flip to "active" with no retry affordance
  // while the user stays blocked. Keeping the DB suspended on failure preserves
  // a truthful, retryable state (cleanup is idempotent — the operator retries).
  try {
    const projects = await getProjectsByUserId(context.get('db'), user.id);
    const stub = context.env.USAGE_COUNTER.get(context.env.USAGE_COUNTER.idFromName(user.id));
    const [, , clearRes] = await Promise.all([
      // `matchReason: null`: an admin unsuspend is authoritative and clears the
      // marker whatever its reason (admin or usage).
      setProjectsRoutingSuspension(context.env.ROUTING, context.get('db'), projects, {
        op: 'unsuspend',
        matchReason: null,
      }),
      context.env.ROUTING.delete(sandboxBlockKey(user.id)),
      stub.fetch(new Request('https://do/clear-suspension', { method: 'POST' })),
    ]);
    // An unchecked DO response would let a 404/500 masquerade as success while
    // the next `/init` re-stamps the routes — leaving the user blocked.
    if (!clearRes.ok) {
      throw new Error(`clear-suspension DO returned HTTP ${clearRes.status}`);
    }
    // Edge enforcement is down — now it's safe to mark the user active in the DB.
    await unsuspendUser(context.get('db'), user.id);
  } catch (error) {
    console.error('[admin] unsuspend cleanup failed', { userId: user.id, error });
    return context.html(
      '<h1>Unsuspend incomplete</h1><p>Edge enforcement state (routing / sandbox-block / usage ' +
        'latch) could not be fully cleared, so the user is still marked suspended. Retry the ' +
        'unsuspend — the cleanup is idempotent.</p>',
      500,
    );
  }

  return context.redirect(`/admin/users/${user.id}`);
});

// POST /users/:id/delete
app.post('/:id/delete', async (context) => {
  const user = await getUser(context.get('db'), context.req.param('id'));
  if (!user) {
    return context.html('<h1>User not found</h1>', 404);
  }
  const projects = await getProjectsByUserId(context.get('db'), user.id);
  for (const project of projects) {
    await teardownProject(context, project.id, project);
  }
  await deleteUser(context.get('db'), user.id);
  return context.redirect('/admin/users');
});

export default app;
