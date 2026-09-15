import { and, count, desc, eq, getTableColumns, ilike, or } from 'drizzle-orm';
import type { Context } from 'hono';
import {
  type Db,
  countUserDeploymentsToday,
  deleteUser,
  getDomainsByProjectId,
  getProject,
  getProjectBuilds,
  getProjectDeployments,
  getProjectResources,
  getProjectsByUserId,
  getUser,
  suspendUser,
  unsuspendUser,
  unsuspendUserIfReason,
  updateUserPlan,
} from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { teardownProject } from '../provisioning/cleanup.ts';
import { getRequestsDataset, queryBatchProjectUsage, ZERO_USAGE } from '../routes/usage.ts';
import {
  refreshProjectKvForUser,
  sandboxBlockKey,
  setProjectsRoutingSuspension,
} from '../routing.ts';
import { deployments, projects, users } from '../schema.ts';
import {
  isAdminSuspended,
  REASON_REQUESTS_EXCEEDED,
  REASON_SANDBOX_RUNTIME_EXCEEDED,
} from '../suspension.ts';
import { getCurrentBillingPeriodStart, PLAN_LIMITS, type PlanId } from '../tiers.ts';
import { OperatorError, preview } from './common.ts';

type Page = { page: number; limit: number; offset: number };

function pageInfo(page: Page, total: number) {
  return {
    page: page.page,
    limit: page.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / page.limit)),
  };
}

export async function listOperatorUsers(db: Db, page: Page, search?: string) {
  const pattern = `%${search}%`;
  const where = search
    ? or(ilike(users.login, pattern), ilike(users.email, pattern), ilike(users.id, pattern))
    : undefined;
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(users)
      .where(where)
      .orderBy(desc(users.created_at), desc(users.id))
      .limit(page.limit)
      .offset(page.offset),
    db.select({ count: count() }).from(users).where(where),
  ]);
  return { users: rows, ...pageInfo(page, total.count) };
}

export async function listOperatorProjects(db: Db, page: Page, search?: string, user?: string) {
  const pattern = `%${search}%`;
  const where = and(
    user ? eq(projects.user_id, user) : undefined,
    search
      ? or(ilike(projects.slug, pattern), ilike(users.login, pattern), ilike(projects.id, pattern))
      : undefined,
  );
  const lastDeploy = db
    .selectDistinctOn([deployments.project_id], {
      project_id: deployments.project_id,
      last_deploy: deployments.created_at,
      last_deploy_id: deployments.id,
      last_deploy_status: deployments.status,
    })
    .from(deployments)
    .orderBy(deployments.project_id, desc(deployments.created_at), desc(deployments.id))
    .as('operator_last_deploy');
  const [rows, [total]] = await Promise.all([
    db
      .select({
        ...getTableColumns(projects),
        owner_login: users.login,
        last_deploy: lastDeploy.last_deploy,
        last_deploy_id: lastDeploy.last_deploy_id,
        last_deploy_status: lastDeploy.last_deploy_status,
      })
      .from(projects)
      .leftJoin(users, eq(projects.user_id, users.id))
      .leftJoin(lastDeploy, eq(projects.id, lastDeploy.project_id))
      .where(where)
      .orderBy(desc(projects.created_at), desc(projects.id))
      .limit(page.limit)
      .offset(page.offset),
    db
      .select({ count: count() })
      .from(projects)
      .leftJoin(users, eq(projects.user_id, users.id))
      .where(where),
  ]);
  return { projects: rows, ...pageInfo(page, total.count) };
}

async function requireUser(db: Db, id: string) {
  const user = await getUser(db, id);
  if (!user) {
    throw new OperatorError(404, 'User not found');
  }
  return user;
}

async function requireProject(db: Db, id: string) {
  const project = await getProject(db, id);
  if (!project) {
    throw new OperatorError(404, 'Project not found');
  }
  return project;
}

export async function getOperatorUser(context: Context<ApiEnv>, id: string) {
  const user = await requireUser(context.get('db'), id);
  const [projects, deploysToday] = await Promise.all([
    getProjectsByUserId(context.get('db'), id),
    countUserDeploymentsToday(context.get('db'), id),
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
  return {
    user,
    projects,
    deploysToday,
    usage: {
      billingPeriodStart: since.toISOString(),
      totalRequests: projectUsages.reduce((sum, p) => sum + p.requests, 0),
      totalBandwidth: projectUsages.reduce((sum, p) => sum + p.bandwidthBytes, 0),
      projects: projectUsages,
    },
  };
}

export async function getOperatorProject(db: Db, id: string) {
  const project = await requireProject(db, id);
  const [deployments, resources, owner, domains, builds] = await Promise.all([
    getProjectDeployments(db, id, 10),
    getProjectResources(db, id),
    getUser(db, project.user_id),
    getDomainsByProjectId(db, id),
    getProjectBuilds(db, id),
  ]);
  return { project, deployments, resources, owner, domains, builds };
}

export async function changeOperatorUserPlan(
  context: Context<ApiEnv>,
  id: string,
  plan: string,
  dryRun = false,
) {
  const db = context.get('db');
  const user = await requireUser(db, id);
  if (!Object.hasOwn(PLAN_LIMITS, plan)) {
    throw new OperatorError(400, 'Invalid plan');
  }
  const newPlan = plan as PlanId;
  const projects = await getProjectsByUserId(db, id);
  const target = { id, login: user.login };
  if (dryRun) {
    return preview('user.plan', target, {
      previousPlan: user.plan,
      plan,
      projects: projects.map((p) => ({ id: p.id, slug: p.slug })),
    });
  }
  await updateUserPlan(db, id, newPlan);
  // Only clear usage reasons. Changing a plan must never lift an admin suspension.
  // Persisting the plan first lets an operator retry this idempotent cleanup.
  try {
    const stub = context.env.USAGE_COUNTER.get(context.env.USAGE_COUNTER.idFromName(id));
    const results = await Promise.allSettled([
      refreshProjectKvForUser(db, context.env.ROUTING, id),
      setProjectsRoutingSuspension(context.env.ROUTING, db, projects, {
        op: 'unsuspend',
        matchReason: REASON_REQUESTS_EXCEEDED,
      }),
      context.env.ROUTING.delete(sandboxBlockKey(id)),
      unsuspendUserIfReason(db, id, REASON_REQUESTS_EXCEEDED),
      unsuspendUserIfReason(db, id, REASON_SANDBOX_RUNTIME_EXCEEDED),
      stub.fetch(
        new Request('https://do/reevaluate-sandbox', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: newPlan }),
        }),
      ),
    ]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') {
      throw failed.reason;
    }
    const reeval = results[5];
    if (reeval.status === 'fulfilled' && !reeval.value.ok) {
      throw new Error(`reevaluate-sandbox DO returned HTTP ${reeval.value.status}`);
    }
  } catch (error) {
    console.error('[admin] plan-change cleanup failed', { userId: id, error });
    throw new OperatorError(
      500,
      'Plan changed, cleanup incomplete. The user may still be blocked. Retry the plan change; cleanup is idempotent.',
      'partial_failure',
      { partial: true, target, plan, cleanupComplete: false },
    );
  }
  return { action: 'user.plan', target, plan, cleanupComplete: true };
}

export async function suspendOperatorUser(
  context: Context<ApiEnv>,
  id: string,
  reason = 'admin_suspended',
  dryRun = false,
) {
  const db = context.get('db');
  const user = await requireUser(db, id);
  if (!isAdminSuspended(reason)) {
    throw new OperatorError(
      400,
      'Reserved reason: automatic usage enforcement reasons cannot be used for an admin suspension.',
    );
  }
  const projects = await getProjectsByUserId(db, id);
  const target = { id, login: user.login };
  if (dryRun) {
    return preview('user.suspend', target, {
      reason,
      projects: projects.map((p) => ({ id: p.id, slug: p.slug })),
    });
  }
  // Edge first, DB last: a failed fan-out leaves a retryable control-plane state.
  try {
    await setProjectsRoutingSuspension(context.env.ROUTING, db, projects, {
      op: 'suspend',
      reason,
      force: true,
    });
    await suspendUser(db, id, reason);
  } catch (error) {
    console.error('[admin] suspend failed', { userId: id, error });
    throw new OperatorError(
      500,
      'Suspend incomplete. Edge enforcement could not be fully stamped. Retry the suspend; the stamp is idempotent.',
      'partial_failure',
      { partial: true, target, reason },
    );
  }
  return { action: 'user.suspend', target, reason };
}

export async function restoreOperatorUser(context: Context<ApiEnv>, id: string, dryRun = false) {
  const db = context.get('db');
  const user = await requireUser(db, id);
  const projects = await getProjectsByUserId(db, id);
  const target = { id, login: user.login };
  if (dryRun) {
    return preview('user.restore', target, {
      previousReason: user.suspended_reason,
      projects: projects.map((p) => ({ id: p.id, slug: p.slug })),
    });
  }
  // Preserve the DB suspension until every routing, sandbox and DO latch clears.
  try {
    const stub = context.env.USAGE_COUNTER.get(context.env.USAGE_COUNTER.idFromName(id));
    const results = await Promise.allSettled([
      setProjectsRoutingSuspension(context.env.ROUTING, db, projects, {
        op: 'unsuspend',
        matchReason: null,
      }),
      context.env.ROUTING.delete(sandboxBlockKey(id)),
      stub.fetch(new Request('https://do/clear-suspension', { method: 'POST' })),
    ]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') {
      throw failed.reason;
    }
    const cleared = results[2];
    if (cleared.status === 'fulfilled' && !cleared.value.ok) {
      throw new Error(`clear-suspension DO returned HTTP ${cleared.value.status}`);
    }
    await unsuspendUser(db, id);
  } catch (error) {
    console.error('[admin] unsuspend cleanup failed', { userId: id, error });
    throw new OperatorError(
      500,
      'Unsuspend incomplete. Edge enforcement state could not be fully cleared. Retry the unsuspend; cleanup is idempotent.',
      'partial_failure',
      { partial: true, target, cleanupComplete: false },
    );
  }
  return { action: 'user.restore', target, cleanupComplete: true };
}

export async function deleteOperatorProject(context: Context<ApiEnv>, id: string, dryRun = false) {
  const project = await requireProject(context.get('db'), id);
  const target = { id, slug: project.slug, userId: project.user_id };
  if (dryRun) {
    const [resources, domains] = await Promise.all([
      getProjectResources(context.get('db'), id),
      getDomainsByProjectId(context.get('db'), id),
    ]);
    return preview('project.delete', target, { resources, domains });
  }
  try {
    const { warnings } = await teardownProject(context, id, project);
    return { action: 'project.delete', target, deleted: true, warnings };
  } catch (error) {
    console.error('[admin] project delete failed', { projectId: id, error });
    throw new OperatorError(
      500,
      'Project deletion incomplete. Some resources may already be removed; inspect the project before retrying.',
      'partial_failure',
      { partial: true, target },
    );
  }
}

export async function deleteOperatorUser(context: Context<ApiEnv>, id: string, dryRun = false) {
  const db = context.get('db');
  const user = await requireUser(db, id);
  const projects = await getProjectsByUserId(db, id);
  const target = { id, login: user.login };
  if (dryRun) {
    return preview('user.delete', target, {
      projects: projects.map((p) => ({ id: p.id, slug: p.slug })),
      deletesAllProjectResources: true,
    });
  }
  const deletedProjects: Array<string> = [];
  const warnings: Array<string> = [];
  let currentProject: string | undefined;
  try {
    for (const project of projects) {
      currentProject = project.id;
      const result = await teardownProject(context, project.id, project);
      deletedProjects.push(project.id);
      warnings.push(...result.warnings);
    }
    currentProject = undefined;
    await deleteUser(db, id);
  } catch (error) {
    console.error('[admin] user delete failed', { userId: id, error });
    throw new OperatorError(
      500,
      'User deletion incomplete. Some projects or resources may already be removed; inspect the user before retrying.',
      'partial_failure',
      { partial: true, target, deletedProjects, currentProject, warnings },
    );
  }
  return { action: 'user.delete', target, deleted: true, deletedProjects, warnings };
}
