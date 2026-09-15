import { count, desc, eq } from 'drizzle-orm';
import { Hono, type MiddlewareHandler } from 'hono';
import type { ApiEnv } from '../env.ts';
import { operatorEvents } from '../schema.ts';
import { dryRun, pagination, readBody } from './common.ts';

const WORKER_NAMES = ['dispatch', 'dashboard', 'api', 'tail', 'proxy'] as const;

function boundedString(value: unknown, maximum: number, lowerCase = false) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    return undefined;
  }
  const trimmed = value.trim();
  return lowerCase ? trimmed.toLowerCase() : trimmed;
}

function pathIdentifier(value: string | undefined) {
  return boundedString(value, 512);
}

function invitationEmails(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    return undefined;
  }
  const emails = value.map((email) => boundedString(email, 320, true));
  return emails.every((email): email is string => email !== undefined)
    ? [...new Set(emails)]
    : undefined;
}

function rollbackVersions(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const input = value as Record<string, unknown>;
  const versions = Object.fromEntries(
    WORKER_NAMES.flatMap((name) => {
      const version = boundedString(input[name], 128);
      return version ? [[name, version]] : [];
    }),
  );
  return Object.keys(versions).length > 0 ? versions : undefined;
}

function auditTarget(path: string, body: Record<string, unknown>, platformEnvironment?: unknown) {
  const segments = path.split('/');
  const id = pathIdentifier(segments[1]);
  if (segments[0] === 'users' && id) {
    if (segments[2] === 'plan') {
      return JSON.stringify({ userId: id, plan: boundedString(body.plan, 512) });
    }
    if (segments[2] === 'suspend') {
      return JSON.stringify({
        userId: id,
        reason: body.reason === undefined ? 'admin_suspended' : boundedString(body.reason, 1000),
      });
    }
    if (segments[2] === 'restore' || segments[2] === 'delete') {
      return JSON.stringify({ userId: id });
    }
  }
  if (segments[0] === 'projects' && id && segments[2] === 'delete') {
    return JSON.stringify({ projectId: id });
  }
  if (segments[0] === 'signup') {
    if (segments[1] === 'restrict' || segments[1] === 'open') {
      return JSON.stringify({ restrictionsEnabled: segments[1] === 'restrict' });
    }
    if (segments[1] === 'allow' || segments[1] === 'remove') {
      return JSON.stringify({
        type: boundedString(body.type, 512),
        pattern: boundedString(body.pattern, 320, true),
        ...(segments[1] === 'allow' ? { note: boundedString(body.note, 1000) } : {}),
      });
    }
  }
  if (segments[0] === 'invitations') {
    if (segments[1] === 'send') {
      return JSON.stringify({ emails: invitationEmails(body.emails) });
    }
    if (id && segments[2] === 'revoke') {
      return JSON.stringify({ invitationId: id });
    }
  }
  if (segments[0] === 'deployments' && id && segments[2] === 'cancel') {
    return JSON.stringify({ deploymentId: id });
  }
  if (segments[0] === 'system' && segments[1] === 'backfill-queue-tokens') {
    return JSON.stringify({ entries: 'queue:*' });
  }
  if (segments[0] === 'workers') {
    const environment = boundedString(body.environment ?? platformEnvironment, 512) ?? 'production';
    if (segments[1] === 'rollback-all') {
      return JSON.stringify({ environment, versions: rollbackVersions(body.versions) });
    }
    if (id && segments[2] === 'rollback') {
      return JSON.stringify({
        workerName: id,
        environment,
        versionId: boundedString(body.versionId, 128),
      });
    }
  }
  return '';
}

async function mutationSucceeded(response: Response) {
  if (!response.ok) {
    return false;
  }
  if (!response.headers.get('Content-Type')?.includes('application/json')) {
    return true;
  }
  try {
    const result: unknown = await response.clone().json();
    return !(
      typeof result === 'object' &&
      result !== null &&
      'ok' in result &&
      result.ok === false
    );
  } catch {
    return true;
  }
}

/** Persist intent before a mutation so an interrupted request stays observable. */
export const operatorAudit: MiddlewareHandler<ApiEnv> = async (context, next) => {
  if (context.req.method !== 'POST' || context.req.path.endsWith('/session/logout')) {
    return next();
  }
  const body = await readBody(context);
  if (dryRun(body)) {
    return next();
  }
  const id = crypto.randomUUID();
  const user = context.get('user');
  const db = context.get('db');
  const path = context.req.path.replace(/^\/operator\/v1\//, '');
  await db.insert(operatorEvents).values({
    id,
    user_id: user.id,
    login: user.login,
    action: path,
    target: auditTarget(path, body, context.env.PLATFORM_ENV),
    status: 'pending',
  });
  await next();
  try {
    const succeeded = await mutationSucceeded(context.res);
    await db
      .update(operatorEvents)
      .set({
        status: succeeded ? 'success' : 'failed',
        http_status: context.res.status,
      })
      .where(eq(operatorEvents.id, id));
  } catch (error) {
    // The mutation may already have completed. Keep its response intact: the
    // durable pending entry signals an outcome requiring investigation.
    console.error('[operator] audit completion failed', id, error);
    context.header('X-Void-Audit-Status', 'pending');
  }
  context.header('X-Void-Audit-Id', id);
};

export const operatorAuditRoutes = new Hono<ApiEnv>();
operatorAuditRoutes.get('/system/events', async (context) => {
  const { page, limit, offset } = pagination(context);
  const db = context.get('db');
  const [events, totals] = await Promise.all([
    db
      .select()
      .from(operatorEvents)
      .orderBy(desc(operatorEvents.created_at), desc(operatorEvents.id))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(operatorEvents),
  ]);
  const total = totals[0]?.total ?? 0;
  return context.json({
    events,
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  });
});
