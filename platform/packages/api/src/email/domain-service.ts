/** Shared owner/operator email-domain service. Cloudflare writes are driven by
 * committed operations in connection-service; no database transaction spans a
 * provider request. */
import { and, eq, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import type { Db, DbOrTx } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import type { Project } from '../types.ts';
import { emailDomainRoutes, emailOperations, emailZoneConnections } from './connection-schema.ts';
import {
  EmailOperationError,
  getEmailOperation,
  requestEmailDomainAdd,
  requestEmailDomainRemove,
  requestEmailDomainSync,
  requestEmailSecretRotation,
  resolveEmailDomain,
  runEmailOperation,
} from './connection-service.ts';
import { normalizeEmailDomain } from './domain-name.ts';
import { getEmailDomainManagement } from './settings.ts';

export const MAX_CREDENTIAL_LENGTH = 2048;
export type EmailDomainAddInput = Readonly<{
  domain: string;
  mode?: unknown;
  refreshToken?: string;
  apiToken?: string;
  attemptId?: unknown;
  managedBy: 'owner' | 'admin';
}>;
export function adminEmailDomainCommand(
  verb: 'add' | 'sync' | 'remove',
  domain: string,
  slug?: string,
): string {
  const base = `void platform email domain-${verb} ${domain}`;
  return verb === 'add' && slug ? `${base} --project ${slug}` : base;
}
export function proxyOriginForEmail(env: ApiEnv['Bindings']): string {
  const origin =
    env.PROXY_URL ??
    (env.PLATFORM_ENV === 'staging'
      ? 'https://proxy.staging.void.cloud'
      : 'https://proxy.void.cloud');
  return origin.replace(/\/+$/, '');
}
export function emailDomainMirrorKey(domain: string): string {
  return `email-domain:${domain}`;
}
export async function revokeRejectedGrant(): Promise<void> {
  /* OAuth grants are no longer accepted for platform email. */
}

export async function getEmailDomainRow(db: Db, projectId: string, domain: string) {
  return (
    (
      await db
        .select()
        .from(emailDomainRoutes)
        .where(
          and(
            eq(emailDomainRoutes.project_id, projectId),
            eq(emailDomainRoutes.domain, normalizeEmailDomain(domain)),
          ),
        )
        .limit(1)
    )[0] ?? null
  );
}
export async function getEmailDomainRowById(db: DbOrTx, id: string) {
  return (
    (await db.select().from(emailDomainRoutes).where(eq(emailDomainRoutes.id, id)).limit(1))[0] ??
    null
  );
}
export async function getEmailDomainRowByDomain(db: Db, domain: string) {
  return (
    (
      await db
        .select()
        .from(emailDomainRoutes)
        .where(eq(emailDomainRoutes.domain, normalizeEmailDomain(domain)))
        .limit(1)
    )[0] ?? null
  );
}
export function serializeEmailRoute(
  route: typeof emailDomainRoutes.$inferSelect,
  connection: typeof emailZoneConnections.$inferSelect,
  operationId?: string,
) {
  return {
    id: route.id,
    domain: route.domain,
    projectId: route.project_id,
    managed_by: route.managed_by,
    status: route.desired_state === 'active' ? route.inbound_status : 'disabled',
    connectionId: connection.id,
    account_id: connection.account_id,
    zone_id: connection.zone_id,
    relay_worker_name: connection.ingress_worker_name,
    relay_version: connection.ingress_version,
    operationId: operationId ?? null,
    readiness: {
      inbound: {
        status: route.inbound_status,
        reason: route.inbound_reason,
        observedAt: route.inbound_observed_at,
      },
      outbound: {
        status: route.outbound_status,
        reason: route.outbound_reason,
        observedAt: route.outbound_observed_at,
      },
      management: {
        status: connection.management_status,
        reason: connection.management_reason,
        observedAt: connection.management_observed_at,
      },
    },
  };
}
export function serializeEmailDomain(
  route: typeof emailDomainRoutes.$inferSelect,
  connection?: typeof emailZoneConnections.$inferSelect,
) {
  return connection
    ? serializeEmailRoute(route, connection)
    : {
        id: route.id,
        domain: route.domain,
        project_id: route.project_id,
        managed_by: route.managed_by,
        status: route.inbound_status,
      };
}
function serviceError(context: Context<ApiEnv>, error: unknown): Response {
  if (error instanceof EmailOperationError) {
    return context.json({ error: error.message }, error.status as 400);
  }
  throw error;
}
async function domainResult(
  context: Context<ApiEnv>,
  project: Project,
  domain: string,
  operationId: string,
): Promise<Response> {
  const resolved = await resolveEmailDomain(context.get('db'), domain);
  const found = await getEmailOperation(context.get('db'), project.id, operationId);
  if (!resolved || !found || resolved.route.project_id !== project.id) {
    return context.json({ error: 'email operation is unavailable', operationId }, 503);
  }
  return context.json({
    ...serializeEmailRoute(resolved.route, resolved.connection, operationId),
    attemptId: found.operation.idempotency_key,
    operationStatus: found.operation.status,
    error: found.operation.failure_detail,
  });
}
export async function addEmailDomainForProject(
  context: Context<ApiEnv>,
  project: Project,
  input: EmailDomainAddInput,
): Promise<Response> {
  try {
    if (input.refreshToken) {
      return context.json(
        {
          error:
            'Cloudflare OAuth grants are not accepted for platform email domains; use a scoped API token',
        },
        400,
      );
    }
    if (project.status === 'deleting') {
      return context.json({ error: 'Project is being deleted' }, 409);
    }
    if (
      input.managedBy === 'owner' &&
      (await getEmailDomainManagement(context.get('db'))) === 'admin'
    ) {
      const existing = await resolveEmailDomain(context.get('db'), input.domain);
      if (
        !existing ||
        existing.route.project_id !== project.id ||
        existing.route.managed_by !== 'owner' ||
        existing.connection.managed_by !== 'owner' ||
        existing.connection.manager_user_id !== context.get('user').id
      ) {
        return context.json(
          {
            error: 'email domains on this platform are managed by its administrator',
            adminCommand: adminEmailDomainCommand('add', input.domain, project.slug),
          },
          403,
        );
      }
    }
    if (input.apiToken && input.apiToken.length > MAX_CREDENTIAL_LENGTH) {
      return context.json({ error: 'invalid credential' }, 400);
    }
    const { operationId } = await requestEmailDomainAdd(context.get('db'), context.env, {
      projectId: project.id,
      domain: input.domain,
      actor: { kind: input.managedBy, userId: context.get('user').id },
      token: input.apiToken,
      attemptId: typeof input.attemptId === 'string' ? input.attemptId : undefined,
    });
    await runEmailOperation(context.get('db'), context.env, operationId);
    return domainResult(context, project, input.domain, operationId);
  } catch (error) {
    return serviceError(context, error);
  }
}
export async function getEmailDomainStatusForProject(
  context: Context<ApiEnv>,
  project: Project,
  rawDomain: string,
): Promise<Response> {
  const resolved = await resolveEmailDomain(context.get('db'), rawDomain);
  if (!resolved || resolved.route.project_id !== project.id) {
    return context.json({ error: 'email domain not found' }, 404);
  }
  const op = (
    await context
      .get('db')
      .select()
      .from(emailOperations)
      .where(eq(emailOperations.route_id, resolved.route.id))
      .orderBy(sql`${emailOperations.created_at} DESC`)
      .limit(1)
  )[0];
  return context.json({
    ...serializeEmailRoute(resolved.route, resolved.connection, op?.id),
    operationStatus: op?.status ?? null,
    error: op?.failure_detail ?? null,
  });
}
export async function syncEmailDomainForProject(
  context: Context<ApiEnv>,
  project: Project,
  rawDomain: string,
  actor: 'owner' | 'admin',
): Promise<Response> {
  try {
    const resolved = await resolveEmailDomain(context.get('db'), rawDomain);
    if (!resolved || resolved.route.project_id !== project.id) {
      return context.json({ error: 'email domain not found' }, 404);
    }
    const operationId = await requestEmailDomainSync(
      context.get('db'),
      context.env,
      resolved.route.id,
      { kind: actor, userId: context.get('user').id },
    );
    await runEmailOperation(context.get('db'), context.env, operationId);
    return domainResult(context, project, rawDomain, operationId);
  } catch (error) {
    return serviceError(context, error);
  }
}
export async function rotateEmailIngressSecretForProject(
  context: Context<ApiEnv>,
  project: Project,
  rawDomain: string,
  actor: 'owner' | 'admin',
  attemptId?: string,
): Promise<Response> {
  try {
    const resolved = await resolveEmailDomain(context.get('db'), rawDomain);
    if (
      !resolved ||
      resolved.route.project_id !== project.id ||
      resolved.route.desired_state !== 'active'
    ) {
      return context.json({ error: 'email domain not found' }, 404);
    }
    const operationId = await requestEmailSecretRotation(
      context.get('db'),
      context.env,
      resolved.connection.id,
      { kind: actor, userId: context.get('user').id },
      attemptId,
    );
    await runEmailOperation(context.get('db'), context.env, operationId);
    const operation = (
      await context
        .get('db')
        .select()
        .from(emailOperations)
        .where(eq(emailOperations.id, operationId))
        .limit(1)
    )[0];
    const current = await resolveEmailDomain(context.get('db'), rawDomain);
    if (!current) {
      return context.json({ error: 'email domain not found' }, 404);
    }
    return context.json({
      ...serializeEmailRoute(current.route, current.connection, operationId),
      operationStatus: operation?.status,
      error: operation?.failure_detail,
    });
  } catch (error) {
    return serviceError(context, error);
  }
}
export async function removeEmailDomainForProject(
  context: Context<ApiEnv>,
  project: Project,
  rawDomain: string,
  force: boolean,
  actor: 'owner' | 'admin',
): Promise<Response> {
  try {
    const resolved = await resolveEmailDomain(context.get('db'), rawDomain);
    if (!resolved || resolved.route.project_id !== project.id) {
      return context.json({ error: 'email domain not found' }, 404);
    }
    const operationId = await requestEmailDomainRemove(
      context.get('db'),
      context.env,
      resolved.route.id,
      { kind: actor, userId: context.get('user').id },
    );
    await runEmailOperation(context.get('db'), context.env, operationId);
    const op = (
      await context
        .get('db')
        .select()
        .from(emailOperations)
        .where(eq(emailOperations.id, operationId))
        .limit(1)
    )[0];
    return context.json({
      ok: op?.status === 'completed',
      removed: op?.status === 'completed',
      operationId,
      operationStatus: op?.status,
      error: op?.failure_detail,
      forced: force && op?.status !== 'completed',
    });
  } catch (error) {
    return serviceError(context, error);
  }
}
export async function getEmailOperationForProject(
  context: Context<ApiEnv>,
  project: Project,
  key: string,
): Promise<Response> {
  const found = await getEmailOperation(context.get('db'), project.id, key);
  if (!found) {
    return context.json({ error: 'email operation not found' }, 404);
  }
  const status = await getEmailDomainStatusForProject(context, project, found.route.domain);
  const domain = (await status.json()) as Record<string, unknown>;
  return context.json({
    operationId: found.operation.id,
    attemptId: found.operation.idempotency_key,
    status: found.operation.status,
    domain: found.route.domain,
    readiness: domain.readiness,
    failedStep: found.operation.current_step,
    error: found.operation.failure_detail,
  });
}
