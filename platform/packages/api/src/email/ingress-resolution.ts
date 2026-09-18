import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { hmacVerifyState } from '../auth/hmac.ts';
import type { ApiEnv } from '../env.ts';
import { getVersionedWorkerName } from '../project-secrets.ts';
import { deployments, projects, users } from '../schema.ts';
import { emailProjectControls } from './admission-schema.ts';
import { emailZoneConnections } from './connection-schema.ts';
import {
  emailInstallationId,
  readConnectionSecret,
  readStagedConnectionSecret,
  resolveEmailIngress,
} from './connection-service.ts';
import { EmailInternalBodyError, readBoundedInternalJson } from './internal-body.ts';

const app = new Hono<ApiEnv>();
app.use('*', async (context, next) => {
  if (!context.req.header('x-void-internal')) {
    return context.json({ error: 'forbidden' }, 403);
  }
  await next();
});
const encoder = new TextEncoder();
function sameSecret(a: string, b: string): boolean {
  const aa = encoder.encode(a),
    bb = encoder.encode(b);
  if (aa.byteLength !== bb.byteLength) {
    return false;
  }
  let difference = 0;
  for (let i = 0; i < aa.byteLength; i++) {
    difference |= aa[i] ^ bb[i];
  }
  return difference === 0;
}

app.post('/probe-ingress', async (context) => {
  let body: { accountId?: unknown; zoneId?: unknown; ingressName?: unknown; secret?: unknown };
  try {
    body = (await readBoundedInternalJson(context.req.raw, 2048)) as typeof body;
  } catch (error) {
    return error instanceof EmailInternalBodyError
      ? context.json({ error: error.message }, error.status)
      : context.json({ error: 'invalid body' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return context.json({ error: 'invalid body' }, 400);
  }
  const { accountId, zoneId, ingressName, secret } = body;
  if (
    [accountId, zoneId, ingressName, secret].some(
      (value) => typeof value !== 'string' || value.length === 0 || value.length > 512,
    )
  ) {
    return context.json({ error: 'invalid probe' }, 400);
  }
  const signed = `email-probe-v1\n${accountId}\n${zoneId}\n${ingressName}`;
  const auth = context.req.header('x-void-internal');
  if (!auth || !(await hmacVerifyState(signed, auth, context.env.JWT_SECRET))) {
    return context.json({ error: 'forbidden' }, 403);
  }
  const connection = (
    await context
      .get('db')
      .select()
      .from(emailZoneConnections)
      .where(
        and(
          eq(emailZoneConnections.installation_id, emailInstallationId(context.env)),
          eq(emailZoneConnections.account_id, accountId as string),
          eq(emailZoneConnections.zone_id, zoneId as string),
          eq(emailZoneConnections.ingress_worker_name, ingressName as string),
        ),
      )
      .limit(1)
  )[0];
  if (!connection) {
    return context.json({ error: 'ingress unavailable' }, 404);
  }
  let accepted = false;
  try {
    accepted = sameSecret(await readConnectionSecret(context.env, connection), secret as string);
    if (!accepted && connection.staged_secret_generation !== null) {
      accepted = sameSecret(
        await readStagedConnectionSecret(context.env, connection),
        secret as string,
      );
    }
  } catch {
    return context.json({ error: 'ingress identity unavailable' }, 503);
  }
  if (!accepted) {
    return context.json({ error: 'forbidden' }, 403);
  }
  return context.body(null, 204);
});

/** Gateway-only read. The HMAC authenticates the service call; the zone
 * bearer separately proves the deployed Cloudflare ingress identity. */
app.post('/resolve-ingress', async (context) => {
  let body: {
    accountId?: unknown;
    zoneId?: unknown;
    ingressName?: unknown;
    from?: unknown;
    to?: unknown;
    secret?: unknown;
    native?: unknown;
  };
  try {
    body = (await readBoundedInternalJson(context.req.raw, 4096)) as typeof body;
  } catch (error) {
    return error instanceof EmailInternalBodyError
      ? context.json({ error: error.message }, error.status)
      : context.json({ error: 'invalid body' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return context.json({ error: 'invalid body' }, 400);
  }
  const { accountId, zoneId, ingressName, to, secret } = body;
  const native = body.native === true;
  if (
    [accountId, zoneId, ingressName, to].some(
      (x) => typeof x !== 'string' || x.length === 0 || x.length > 512,
    ) ||
    (!native && (typeof secret !== 'string' || secret.length === 0 || secret.length > 512))
  ) {
    return context.json({ error: 'invalid ingress identity' }, 400);
  }
  const recipient = (to as string).toLowerCase();
  const signed = `email-ingress-v1\n${accountId}\n${zoneId}\n${ingressName}\n${recipient}`;
  const auth = context.req.header('x-void-internal');
  if (!auth || !(await hmacVerifyState(signed, auth, context.env.JWT_SECRET))) {
    return context.json({ error: 'forbidden' }, 403);
  }
  const db = context.get('db');
  const resolved = await resolveEmailIngress(db, {
    installationId: emailInstallationId(context.env),
    accountId: accountId as string,
    zoneId: zoneId as string,
    ingressName: ingressName as string,
    recipient: recipient,
  });
  if (!resolved) {
    return context.json({ error: 'unregistered or disabled email domain' }, 404);
  }
  const route = resolved.route;
  if (native) {
    const shared = context.env as ApiEnv['Bindings'] & {
      EMAIL_SHARED_ACCOUNT_ID?: string;
      EMAIL_SHARED_ZONE_ID?: string;
      EMAIL_SHARED_INGRESS_NAME?: string;
    };
    if (
      resolved.connection.managed_by !== 'admin' ||
      resolved.connection.account_id !== context.env.CF_ACCOUNT_ID ||
      !shared.EMAIL_SHARED_ACCOUNT_ID ||
      !shared.EMAIL_SHARED_ZONE_ID ||
      !shared.EMAIL_SHARED_INGRESS_NAME ||
      shared.EMAIL_SHARED_ACCOUNT_ID !== accountId ||
      shared.EMAIL_SHARED_ZONE_ID !== zoneId ||
      shared.EMAIL_SHARED_INGRESS_NAME !== ingressName
    ) {
      return context.json({ error: 'forbidden' }, 403);
    }
    if (
      route.addressing === 'shared' &&
      route.domain !== context.env.EMAIL_SENDER_DOMAIN?.toLowerCase()
    ) {
      return context.json({ error: 'forbidden' }, 403);
    }
  } else {
    let expected: string;
    try {
      expected = await readConnectionSecret(context.env, resolved.connection);
    } catch {
      return context.json({ error: 'ingress identity unavailable' }, 503);
    }
    let authorized = sameSecret(expected, secret as string);
    if (!authorized && resolved.connection.staged_secret_generation !== null) {
      try {
        authorized = sameSecret(
          await readStagedConnectionSecret(context.env, resolved.connection),
          secret as string,
        );
      } catch {
        return context.json({ error: 'staged ingress identity unavailable' }, 503);
      }
    }
    if (
      !authorized &&
      resolved.connection.previous_secret_hash &&
      resolved.connection.previous_secret_until &&
      Date.parse(resolved.connection.previous_secret_until) > Date.now()
    ) {
      const hash = Array.from(
        new Uint8Array(
          await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(secret))),
        ),
        (x) => x.toString(16).padStart(2, '0'),
      ).join('');
      authorized = sameSecret(resolved.connection.previous_secret_hash, hash);
    }
    if (!authorized) {
      return context.json({ error: 'forbidden' }, 403);
    }
  }
  let projectId = route.project_id;
  let slug: string;
  if (route.addressing === 'shared') {
    const local = recipient.slice(0, recipient.lastIndexOf('@'));
    const slugPart = local.split('+', 1)[0];
    if (!slugPart) {
      return context.json({ error: 'unknown shared recipient' }, 404);
    }
    const project = (
      await db
        .select({
          id: projects.id,
          slug: projects.slug,
          status: projects.status,
          active_deployment_id: projects.active_deployment_id,
        })
        .from(projects)
        .where(and(eq(projects.slug, slugPart), eq(projects.status, 'active')))
        .limit(1)
    )[0];
    if (!project) {
      return context.json({ error: 'unknown shared recipient' }, 404);
    }
    projectId = project.id;
    slug = project.slug;
  } else {
    const project = (
      await db
        .select({ id: projects.id, slug: projects.slug, status: projects.status })
        .from(projects)
        .where(eq(projects.id, projectId!))
        .limit(1)
    )[0];
    if (!project || project.status !== 'active') {
      return context.json({ error: 'project unavailable' }, 404);
    }
    slug = project.slug;
  }
  const authority = (
    await db
      .select({
        projectStatus: projects.status,
        suspendedReason: users.suspended_reason,
        emailSuspendedAt: emailProjectControls.suspended_at,
      })
      .from(projects)
      .innerJoin(users, eq(projects.user_id, users.id))
      .leftJoin(emailProjectControls, eq(emailProjectControls.project_id, projects.id))
      .where(eq(projects.id, projectId!))
      .limit(1)
  )[0];
  if (
    !authority ||
    authority.projectStatus !== 'active' ||
    authority.suspendedReason ||
    authority.emailSuspendedAt
  ) {
    return context.json({ error: 'project email is suspended' }, 403);
  }
  const project = (
    await db
      .select({ active_deployment_id: projects.active_deployment_id })
      .from(projects)
      .where(eq(projects.id, projectId!))
      .limit(1)
  )[0];
  const deploymentId = project?.active_deployment_id;
  if (!deploymentId) {
    return context.json({ error: 'project has no deployment' }, 409);
  }
  const deployment = (
    await db
      .select({ manifest: deployments.manifest, status: deployments.status })
      .from(deployments)
      .where(and(eq(deployments.id, deploymentId), eq(deployments.project_id, projectId!)))
      .limit(1)
  )[0];
  let protocolVersion: unknown;
  try {
    protocolVersion = deployment?.manifest
      ? JSON.parse(deployment.manifest).emailProtocolVersion
      : null;
  } catch {
    protocolVersion = null;
  }
  if (deployment?.status !== 'live' || protocolVersion !== 1) {
    return context.json(
      { error: 'active deployment does not support email gateway protocol' },
      409,
    );
  }
  return context.json({
    projectId,
    slug,
    deploymentId,
    workerName: getVersionedWorkerName(slug, deploymentId),
    addressing: route.addressing,
    domain: route.domain,
    connectionId: resolved.connection.id,
  });
});

export default app;
