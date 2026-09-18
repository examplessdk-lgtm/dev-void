import { and, count, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { generateId } from '../id.ts';
import { decryptPlatformCredential, encryptPlatformCredential } from '../project-secrets.ts';
import { projects } from '../schema.ts';
import { emailUnresolvedAttempts } from './admission-schema.ts';
import { disableEmailDomainRouteAndDrainTx } from './admission.ts';
import { createCfCustomerClient } from './cf-customer.ts';
import {
  emailCacheOutbox,
  emailCredentials,
  emailDomainRoutes,
  emailOperations,
  emailOperationSteps,
  emailZoneConnections,
} from './connection-schema.ts';
import { isValidEmailDomain, normalizeEmailDomain } from './domain-name.ts';
import {
  findZoneForEmailDomain,
  lookupMxOverDns,
  sendingOnboardedReadback,
} from './relay-engine.ts';
import { RELAY_COMPATIBILITY_DATE, RELAY_SOURCE, RELAY_VERSION } from './relay-worker.ts';

type Bindings = ApiEnv['Bindings'];
export type EmailActor =
  | { kind: 'owner'; userId: string }
  | { kind: 'admin'; userId: string }
  | { kind: 'system' };
export class EmailOperationError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

const SETUP_STEPS = [
  'routing_enable',
  'ingress_deploy',
  'probe_route_enable',
  'secret_put',
  'relay_probe',
  'gateway_probe',
  'catchall_ensure',
  'inbound_probe',
  'sending_onboard',
  'publish',
] as const;
const SYNC_STEPS = [
  'ingress_deploy',
  'probe_route_enable',
  'relay_probe',
  'gateway_probe',
  'catchall_ensure',
  'inbound_probe',
  'sending_onboard',
  'publish',
] as const;
const SIBLING_STEPS = [
  'routing_enable',
  'gateway_probe',
  'inbound_probe',
  'sending_onboard',
  'publish',
] as const;
const SHARED_SYNC_STEPS = [
  'routing_enable',
  'inbound_probe',
  'sending_onboard',
  'publish',
] as const;
const REMOVE_STEPS = ['route_disable', 'catchall_detach', 'ingress_delete', 'publish'] as const;
const ROTATE_STEPS = [
  'secret_put',
  'relay_probe',
  'gateway_probe',
  'secret_promote',
  'publish',
] as const;
type StepKind =
  | (typeof SETUP_STEPS)[number]
  | (typeof REMOVE_STEPS)[number]
  | (typeof ROTATE_STEPS)[number];

export function emailInstallationId(env: Bindings): string {
  return env.PLATFORM_INSTALLATION_ID ?? 'void-hosted';
}
function gatewayOrigin(env: Bindings): string {
  const origin = (env as Bindings & { EMAIL_GATEWAY_ORIGIN?: string }).EMAIL_GATEWAY_ORIGIN;
  if (!origin || !/^https:\/\/[^/]+$/i.test(origin)) {
    throw new EmailOperationError(
      'EMAIL_GATEWAY_ORIGIN must be configured before email ingress setup',
      503,
    );
  }
  return origin;
}
async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (x) =>
    x.toString(16).padStart(2, '0'),
  ).join('');
}
function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
async function relayProof(
  secret: string,
  connection: typeof emailZoneConnections.$inferSelect,
  generation: number,
  challenge: string,
): Promise<string> {
  const data = [
    'email-relay-proof-v1',
    connection.account_id,
    connection.zone_id,
    connection.ingress_worker_name,
    String(generation),
    challenge,
  ].join('\n');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
async function probeDeployedRelay(
  client: ReturnType<typeof createCfCustomerClient>,
  env: Bindings,
  connection: typeof emailZoneConnections.$inferSelect,
  staged: boolean,
): Promise<Record<string, unknown>> {
  if (
    !(await client.getScriptSubdomainEnabled(connection.account_id, connection.ingress_worker_name))
  ) {
    throw new EmailOperationError('ingress probe endpoint is disabled', 503);
  }
  const subdomain = await client.getWorkersSubdomain(connection.account_id);
  if (!/^[a-z0-9-]+$/i.test(subdomain)) {
    throw new EmailOperationError('invalid Cloudflare Workers subdomain', 503);
  }
  const generation = staged
    ? connection.staged_secret_generation
    : connection.active_secret_generation;
  if (generation === null) {
    throw new EmailOperationError('staged ingress generation is absent');
  }
  const secret = staged
    ? await readStagedConnectionSecret(env, connection)
    : await readConnectionSecret(env, connection);
  const challenge = randomSecret();
  const response = await fetch(
    `https://${connection.ingress_worker_name}.${subdomain}.workers.dev/__void/email/probe`,
    {
      method: 'POST',
      headers: {
        'X-Void-Probe-Challenge': challenge,
        'X-Void-Probe-Generation': String(generation),
      },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) {
    throw new EmailOperationError(`deployed ingress probe returned HTTP ${response.status}`, 503);
  }
  if (!response.body) {
    throw new EmailOperationError('deployed ingress proof body is empty', 503);
  }
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > 2048) {
        throw new EmailOperationError('deployed ingress proof is too large', 503);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: {
    accountId?: unknown;
    zoneId?: unknown;
    ingressName?: unknown;
    generation?: unknown;
    challenge?: unknown;
    proof?: unknown;
  };
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new EmailOperationError('deployed ingress proof is invalid', 503);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new EmailOperationError('deployed ingress proof is invalid', 503);
  }
  if (
    body.accountId !== connection.account_id ||
    body.zoneId !== connection.zone_id ||
    body.ingressName !== connection.ingress_worker_name ||
    body.generation !== generation ||
    body.challenge !== challenge ||
    typeof body.proof !== 'string' ||
    !constantTimeHexEqual(body.proof, await relayProof(secret, connection, generation, challenge))
  ) {
    throw new EmailOperationError('deployed ingress proof did not match staged identity', 503);
  }
  return { generation, workerName: connection.ingress_worker_name, proved: true };
}
async function probeGatewayAcceptance(
  env: Bindings,
  connection: typeof emailZoneConnections.$inferSelect,
  staged: boolean,
): Promise<Record<string, unknown>> {
  const secret = staged
    ? await readStagedConnectionSecret(env, connection)
    : await readConnectionSecret(env, connection);
  const payload = JSON.stringify({
    accountId: connection.account_id,
    zoneId: connection.zone_id,
    ingressName: connection.ingress_worker_name,
  });
  const response = await fetch(`${gatewayOrigin(env)}/email/probe`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      'Content-Length': String(new TextEncoder().encode(payload).byteLength),
    },
    body: payload,
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  if (response.status !== 204) {
    throw new EmailOperationError(
      `email gateway rejected ingress identity with HTTP ${response.status}`,
      503,
    );
  }
  return {
    accepted: true,
    generation: staged ? connection.staged_secret_generation : connection.active_secret_generation,
  };
}
function ingressName(installationId: string, zoneId: string): string {
  // Stable, bounded, and owned by an installation/zone rather than a project.
  const suffix = [installationId, zoneId]
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(-48);
  return `void-email-${suffix}`;
}
function isSharedGatewayConnection(
  env: Bindings,
  connection: typeof emailZoneConnections.$inferSelect,
): boolean {
  const shared = env as Bindings & {
    EMAIL_SHARED_ACCOUNT_ID?: string;
    EMAIL_SHARED_ZONE_ID?: string;
    EMAIL_SHARED_INGRESS_NAME?: string;
  };
  return (
    !!shared.EMAIL_SHARED_ACCOUNT_ID &&
    !!shared.EMAIL_SHARED_ZONE_ID &&
    !!shared.EMAIL_SHARED_INGRESS_NAME &&
    connection.account_id === shared.EMAIL_SHARED_ACCOUNT_ID &&
    connection.zone_id === shared.EMAIL_SHARED_ZONE_ID &&
    connection.ingress_worker_name === shared.EMAIL_SHARED_INGRESS_NAME
  );
}
function canManageConnection(
  actor: EmailActor,
  connection: typeof emailZoneConnections.$inferSelect,
): boolean {
  if (actor.kind === 'system') {
    return true;
  }
  return (
    connection.managed_by === actor.kind &&
    (actor.kind === 'admin' || connection.manager_user_id === actor.userId)
  );
}

export async function resolveEmailDomain(db: DbOrTx, rawDomain: string) {
  const domain = normalizeEmailDomain(rawDomain);
  const rows = await db
    .select({ route: emailDomainRoutes, connection: emailZoneConnections })
    .from(emailDomainRoutes)
    .innerJoin(emailZoneConnections, eq(emailDomainRoutes.connection_id, emailZoneConnections.id))
    .where(eq(emailDomainRoutes.domain, domain))
    .limit(1);
  return rows[0] ?? null;
}

export async function resolveEmailIngress(
  db: DbOrTx,
  input: {
    installationId: string;
    accountId: string;
    zoneId: string;
    ingressName: string;
    recipient: string;
  },
) {
  const at = input.recipient.lastIndexOf('@');
  if (at <= 0) {
    return null;
  }
  const found = await resolveEmailDomain(db, input.recipient.slice(at + 1));
  if (
    !found ||
    found.route.desired_state !== 'active' ||
    found.route.inbound_status !== 'ready' ||
    found.connection.inbound_status !== 'ready'
  ) {
    return null;
  }
  if (
    found.connection.installation_id !== input.installationId ||
    found.connection.account_id !== input.accountId ||
    found.connection.zone_id !== input.zoneId ||
    found.connection.ingress_worker_name !== input.ingressName
  ) {
    return null;
  }
  if (found.route.addressing === 'custom' && !found.route.project_id) {
    return null;
  }
  return found;
}

export async function credentialFor(
  env: Bindings,
  db: DbOrTx,
  connection: typeof emailZoneConnections.$inferSelect,
): Promise<string> {
  if (!connection.credential_id) {
    throw new EmailOperationError('email connection has no credential', 503);
  }
  const row = (
    await db
      .select()
      .from(emailCredentials)
      .where(eq(emailCredentials.id, connection.credential_id))
      .limit(1)
  )[0];
  if (
    !row ||
    row.status !== 'healthy' ||
    row.installation_id !== connection.installation_id ||
    row.account_id !== connection.account_id ||
    row.zone_id !== connection.zone_id
  ) {
    throw new EmailOperationError('email connection credential is unavailable', 503);
  }
  if (row.kind === 'platform') {
    if (connection.account_id !== env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
      throw new EmailOperationError('platform credential cannot manage this zone', 403);
    }
    return env.CF_API_TOKEN;
  }
  if (!row.ciphertext || !row.iv || !row.key_version) {
    throw new EmailOperationError('stored email credential is incomplete', 503);
  }
  return decryptPlatformCredential(env, row.installation_id, row.id, {
    ciphertext: row.ciphertext,
    iv: row.iv,
    keyVersion: row.key_version,
  });
}

export async function readConnectionSecret(
  env: Bindings,
  connection: typeof emailZoneConnections.$inferSelect,
): Promise<string> {
  return decryptPlatformCredential(
    env,
    connection.installation_id,
    `${connection.id}:secret:${connection.active_secret_generation}`,
    {
      ciphertext: connection.secret_ciphertext,
      iv: connection.secret_iv,
      keyVersion: connection.secret_key_version,
    },
  );
}
export async function readStagedConnectionSecret(
  env: Bindings,
  connection: typeof emailZoneConnections.$inferSelect,
): Promise<string> {
  if (
    connection.staged_secret_generation === null ||
    !connection.staged_secret_ciphertext ||
    !connection.staged_secret_iv ||
    !connection.staged_secret_key_version
  ) {
    throw new EmailOperationError('no staged ingress secret', 409);
  }
  return decryptPlatformCredential(
    env,
    connection.installation_id,
    `${connection.id}:secret:${connection.staged_secret_generation}`,
    {
      ciphertext: connection.staged_secret_ciphertext,
      iv: connection.staged_secret_iv,
      keyVersion: connection.staged_secret_key_version,
    },
  );
}

export async function requestEmailDomainAdd(
  db: Db,
  env: Bindings,
  input: {
    projectId: string;
    domain: string;
    actor: EmailActor;
    token?: string;
    attemptId?: string;
  },
): Promise<{ operationId: string; routeId: string }> {
  const domain = normalizeEmailDomain(input.domain);
  if (!isValidEmailDomain(domain)) {
    throw new EmailOperationError('invalid email domain', 400);
  }
  if (input.actor.kind === 'system') {
    throw new EmailOperationError('system cannot assign project email domains', 403);
  }
  const actor = input.actor as Exclude<EmailActor, { kind: 'system' }>;
  const installationId = emailInstallationId(env);
  const key = input.attemptId ?? generateId('eadd');
  const actorScope = `${actor.kind}:${actor.userId}:${input.projectId}`;
  const requestDigest = await digest({
    projectId: input.projectId,
    domain,
    actor: input.actor.kind,
    tokenDigest: input.token ? await digest(input.token) : null,
  });
  const previous = (
    await db
      .select()
      .from(emailOperations)
      .where(
        and(
          eq(emailOperations.installation_id, installationId),
          eq(emailOperations.actor_scope, actorScope),
          eq(emailOperations.idempotency_key, key),
        ),
      )
      .limit(1)
  )[0];
  if (previous) {
    if (previous.request_digest !== requestDigest || !previous.route_id) {
      throw new EmailOperationError('email operation key was reused with a different request');
    }
    return { operationId: previous.id, routeId: previous.route_id };
  }
  if (!input.token && input.actor.kind === 'owner') {
    throw new EmailOperationError('a scoped Cloudflare API token is required', 400);
  }
  const token = input.token ?? env.CF_API_TOKEN;
  if (!token) {
    throw new EmailOperationError('platform Cloudflare credential is unavailable', 503);
  }
  const client = createCfCustomerClient(token);
  const zone = await findZoneForEmailDomain(client, domain);
  if (!zone) {
    throw new EmailOperationError(`no Cloudflare zone found for ${domain}`, 404);
  }
  const shared = env as Bindings & {
    EMAIL_SHARED_ACCOUNT_ID?: string;
    EMAIL_SHARED_ZONE_ID?: string;
    EMAIL_SHARED_INGRESS_NAME?: string;
  };
  if (
    zone.account.id === shared.EMAIL_SHARED_ACCOUNT_ID &&
    zone.id === shared.EMAIL_SHARED_ZONE_ID
  ) {
    if (actor.kind !== 'admin') {
      throw new EmailOperationError(
        'the installation shared mail zone is administrator-managed',
        403,
      );
    }
    const bootstrap = await ensureSharedEmailConnection(db, env);
    if (bootstrap) {
      await runEmailOperation(db, env, bootstrap);
    }
  }
  if (!input.token && zone.account.id !== env.CF_ACCOUNT_ID) {
    throw new EmailOperationError(
      'administrator must supply a token for this Cloudflare account',
      403,
    );
  }
  if (input.token) {
    const verification = await client.verifyToken();
    if (verification.status !== 'active') {
      throw new EmailOperationError('Cloudflare API token is not active', 403);
    }
    // The actual zone read above proves resource scope more reliably than a template URL.
    await client.getRoutingSettings(zone.id);
  }
  const existingConnection = (
    await db
      .select()
      .from(emailZoneConnections)
      .where(
        and(
          eq(emailZoneConnections.installation_id, installationId),
          eq(emailZoneConnections.account_id, zone.account.id),
          eq(emailZoneConnections.zone_id, zone.id),
        ),
      )
      .limit(1)
  )[0];
  if (!existingConnection) {
    const preflight = await Promise.all([
      lookupMxOverDns(domain),
      client.getCatchAll(zone.id),
      client.listRoutingRules(zone.id),
    ]);
    if (preflight[0].length > 0) {
      throw new EmailOperationError(
        `${domain} already has MX records; use an unused mail subdomain`,
        409,
      );
    }
    if (preflight[1]?.enabled && preflight[1].workerName !== ingressName(installationId, zone.id)) {
      throw new EmailOperationError(
        'an unrelated catch-all already owns this Cloudflare zone',
        409,
      );
    }
    const conflicts = preflight[2].filter(
      (rule) => rule.enabled && rule.addresses.some((address) => address.endsWith(`@${domain}`)),
    );
    if (conflicts.length > 0) {
      throw new EmailOperationError(
        `enabled explicit Cloudflare email rules conflict with ${domain}`,
        409,
      );
    }
  }
  gatewayOrigin(env);
  const connectionId = generateId('econ');
  const routeId = generateId('eroute');
  const operationId = generateId('eop');
  const credentialId = generateId('ecred');
  const secret = randomSecret();
  const encryptedSecret = await encryptPlatformCredential(
    env,
    installationId,
    `${connectionId}:secret:1`,
    secret,
  );
  const encryptedToken = input.token
    ? await encryptPlatformCredential(env, installationId, credentialId, token)
    : null;
  try {
    return await db.transaction(async (tx) => {
      const project = (
        await tx
          .select()
          .from(projects)
          .where(eq(projects.id, input.projectId))
          .for('update')
          .limit(1)
      )[0];
      if (!project || project.status === 'deleting') {
        throw new EmailOperationError('project not available', 409);
      }
      if (actor.kind === 'owner' && project.user_id !== actor.userId) {
        throw new EmailOperationError('forbidden', 403);
      }
      const existingRoute = (
        await tx
          .select()
          .from(emailDomainRoutes)
          .where(eq(emailDomainRoutes.domain, domain))
          .limit(1)
      )[0];
      if (existingRoute && existingRoute.project_id !== input.projectId) {
        throw new EmailOperationError('email domain is assigned to another project', 409);
      }
      let connection = (
        await tx
          .select()
          .from(emailZoneConnections)
          .where(
            and(
              eq(emailZoneConnections.installation_id, installationId),
              eq(emailZoneConnections.account_id, zone.account.id),
              eq(emailZoneConnections.zone_id, zone.id),
            ),
          )
          .for('update')
          .limit(1)
      )[0];
      const created = !connection;
      if (connection && !canManageConnection(actor, connection)) {
        throw new EmailOperationError('zone connection requires its manager approval', 403);
      }
      if (connection) {
        const unresolved = (
          await tx
            .select({ id: emailOperations.id })
            .from(emailOperations)
            .where(
              and(
                eq(emailOperations.connection_id, connection.id),
                inArray(emailOperations.status, ['pending', 'running', 'unknown']),
              ),
            )
            .limit(1)
        )[0];
        if (unresolved) {
          throw new EmailOperationError(`connection operation ${unresolved.id} is unresolved`);
        }
      }
      if (existingRoute) {
        if (
          !connection ||
          !canManageConnection(actor, connection) ||
          existingRoute.managed_by !== actor.kind
        ) {
          throw new EmailOperationError(
            'email domain credential may be replaced only by its connection manager',
            403,
          );
        }
        if (!connection.credential_id) {
          throw new EmailOperationError('connection credential missing', 503);
        }
        const replacement = input.token
          ? await encryptPlatformCredential(
              env,
              installationId,
              connection.credential_id,
              input.token,
            )
          : null;
        await tx
          .update(emailCredentials)
          .set({
            kind: input.token ? 'api_token' : 'platform',
            ciphertext: replacement?.ciphertext ?? null,
            iv: replacement?.iv ?? null,
            key_version: replacement?.keyVersion ?? null,
            status: 'healthy',
            generation: sql`${emailCredentials.generation} + 1`,
            updated_at: sql`now()`,
          })
          .where(eq(emailCredentials.id, connection.credential_id));
        const generation = connection.desired_generation + 1;
        await tx
          .update(emailZoneConnections)
          .set({
            desired_generation: generation,
            management_status: 'healthy',
            management_observed_at: sql`now()`,
            updated_at: sql`now()`,
          })
          .where(eq(emailZoneConnections.id, connection.id));
        await tx
          .update(emailDomainRoutes)
          .set({ desired_state: 'active', updated_at: sql`now()` })
          .where(eq(emailDomainRoutes.id, existingRoute.id));
        await tx.insert(emailOperations).values({
          id: operationId,
          installation_id: installationId,
          connection_id: connection.id,
          route_id: existingRoute.id,
          actor_kind: actor.kind,
          actor_user_id: actor.userId,
          actor_scope: actorScope,
          kind: 'sync',
          idempotency_key: key,
          request_digest: requestDigest,
          desired_generation: generation,
        });
        for (let i = 0; i < SYNC_STEPS.length; i++) {
          await tx.insert(emailOperationSteps).values({
            id: generateId('estep'),
            operation_id: operationId,
            ordinal: i,
            kind: SYNC_STEPS[i],
            resource_identity: `${connection.account_id}/${connection.zone_id}/${connection.ingress_worker_name}`,
            request_digest: await digest({
              kind: SYNC_STEPS[i],
              connectionId: connection.id,
              generation,
            }),
          });
        }
        return { operationId, routeId: existingRoute.id };
      }
      if (!connection) {
        await tx.insert(emailCredentials).values({
          id: credentialId,
          installation_id: installationId,
          managed_by: actor.kind,
          manager_user_id: actor.kind === 'owner' ? actor.userId : null,
          kind: input.token ? 'api_token' : 'platform',
          account_id: zone.account.id,
          zone_id: zone.id,
          ciphertext: encryptedToken?.ciphertext ?? null,
          iv: encryptedToken?.iv ?? null,
          key_version: encryptedToken?.keyVersion ?? null,
        });
        await tx.insert(emailZoneConnections).values({
          id: connectionId,
          installation_id: installationId,
          account_id: zone.account.id,
          zone_id: zone.id,
          zone_name: zone.name,
          managed_by: actor.kind,
          manager_user_id: actor.kind === 'owner' ? actor.userId : null,
          credential_id: credentialId,
          ingress_worker_name: ingressName(installationId, zone.id),
          secret_ciphertext: encryptedSecret.ciphertext,
          secret_iv: encryptedSecret.iv,
          secret_key_version: encryptedSecret.keyVersion,
          active_secret_generation: 1,
          management_status: 'healthy',
          management_observed_at: sql`now()`,
        });
        connection = (
          await tx
            .select()
            .from(emailZoneConnections)
            .where(eq(emailZoneConnections.id, connectionId))
            .limit(1)
        )[0]!;
      } else if (input.token) {
        // A sibling assignment supplies the manager's current zone token.
        // The connection, rather than either project, owns its ciphertext.
        if (!connection.credential_id) {
          throw new EmailOperationError('connection credential missing', 503);
        }
        const replacement = await encryptPlatformCredential(
          env,
          installationId,
          connection.credential_id,
          input.token,
        );
        await tx
          .update(emailCredentials)
          .set({
            kind: 'api_token',
            ciphertext: replacement.ciphertext,
            iv: replacement.iv,
            key_version: replacement.keyVersion,
            status: 'healthy',
            generation: sql`${emailCredentials.generation} + 1`,
            updated_at: sql`now()`,
          })
          .where(eq(emailCredentials.id, connection.credential_id));
      }
      await tx.insert(emailDomainRoutes).values({
        id: routeId,
        domain,
        connection_id: connection.id,
        project_id: input.projectId,
        addressing: 'custom',
        managed_by: actor.kind,
        assigned_by_user_id: actor.userId,
      });
      await tx.insert(emailOperations).values({
        id: operationId,
        installation_id: installationId,
        connection_id: connection.id,
        route_id: routeId,
        actor_kind: actor.kind,
        actor_user_id: actor.userId,
        actor_scope: actorScope,
        kind: 'setup',
        idempotency_key: key,
        request_digest: requestDigest,
        desired_generation: connection.desired_generation,
      });
      const steps = created ? SETUP_STEPS : SIBLING_STEPS;
      for (let i = 0; i < steps.length; i++) {
        await tx.insert(emailOperationSteps).values({
          id: generateId('estep'),
          operation_id: operationId,
          ordinal: i,
          kind: steps[i],
          resource_identity: `${connection.account_id}/${connection.zone_id}/${connection.ingress_worker_name}`,
          request_digest: await digest({
            kind: steps[i],
            connectionId: connection.id,
            generation: connection.desired_generation,
          }),
        });
      }
      return { operationId, routeId };
    });
  } catch (error) {
    // A concurrent insert may have committed the same caller attempt while this
    // transaction waited on uniqueness. Fetch it, but never infer success from a domain row.
    const winner = (
      await db
        .select()
        .from(emailOperations)
        .where(
          and(
            eq(emailOperations.installation_id, installationId),
            eq(emailOperations.actor_scope, actorScope),
            eq(emailOperations.idempotency_key, key),
          ),
        )
        .limit(1)
    )[0];
    if (winner && winner.request_digest === requestDigest && winner.route_id) {
      return { operationId: winner.id, routeId: winner.route_id };
    }
    throw error;
  }
}

/** Reserve the installation's shared sender as an exact route on its zone.
 * This uses the same durable step runner as project assignments. It is safe to
 * call from scheduled reconciliation: the stable key returns the same operation. */
export async function ensureSharedEmailConnection(db: Db, env: Bindings): Promise<string | null> {
  const configured = env.EMAIL_SENDER_DOMAIN;
  if (!configured) {
    return null;
  }
  const shared = env as Bindings & {
    EMAIL_SHARED_ACCOUNT_ID?: string;
    EMAIL_SHARED_ZONE_ID?: string;
    EMAIL_SHARED_INGRESS_NAME?: string;
  };
  if (
    !shared.EMAIL_SHARED_ACCOUNT_ID ||
    !shared.EMAIL_SHARED_ZONE_ID ||
    !shared.EMAIL_SHARED_INGRESS_NAME
  ) {
    throw new EmailOperationError('shared email ingress identity is not configured', 503);
  }
  const domain = normalizeEmailDomain(configured);
  if (!isValidEmailDomain(domain)) {
    throw new EmailOperationError('EMAIL_SENDER_DOMAIN is invalid', 503);
  }
  gatewayOrigin(env);
  const installationId = emailInstallationId(env);
  const key = `shared:${domain}`;
  const previous = (
    await db
      .select()
      .from(emailOperations)
      .where(
        and(
          eq(emailOperations.installation_id, installationId),
          eq(emailOperations.actor_scope, 'system:shared'),
          eq(emailOperations.idempotency_key, key),
        ),
      )
      .limit(1)
  )[0];
  if (previous) {
    return previous.id;
  }
  const client = createCfCustomerClient(env.CF_API_TOKEN);
  const zone = await findZoneForEmailDomain(client, domain);
  if (
    !zone ||
    zone.account.id !== env.CF_ACCOUNT_ID ||
    zone.account.id !== shared.EMAIL_SHARED_ACCOUNT_ID ||
    zone.id !== shared.EMAIL_SHARED_ZONE_ID
  ) {
    throw new EmailOperationError(
      'shared sender zone does not match the configured gateway identity',
      503,
    );
  }
  const existingRule = await client.getCatchAll(zone.id);
  const worker = shared.EMAIL_SHARED_INGRESS_NAME;
  if (existingRule?.enabled && existingRule.workerName !== worker) {
    throw new EmailOperationError('shared sender zone has a foreign catch-all', 409);
  }
  const routeId = generateId('eroute'),
    connectionId = generateId('econ'),
    credentialId = generateId('ecred'),
    operationId = generateId('eop');
  const secret = await encryptPlatformCredential(
    env,
    installationId,
    `${connectionId}:secret:1`,
    randomSecret(),
  );
  return db.transaction(async (tx) => {
    const existingRoute = (
      await tx.select().from(emailDomainRoutes).where(eq(emailDomainRoutes.domain, domain)).limit(1)
    )[0];
    if (existingRoute) {
      if (existingRoute.addressing !== 'shared') {
        throw new EmailOperationError('shared sender domain is assigned to a project');
      }
      const latest = (
        await tx
          .select()
          .from(emailOperations)
          .where(eq(emailOperations.route_id, existingRoute.id))
          .orderBy(sql`${emailOperations.created_at} DESC`)
          .limit(1)
      )[0];
      return latest?.id ?? null;
    }
    let connection = (
      await tx
        .select()
        .from(emailZoneConnections)
        .where(
          and(
            eq(emailZoneConnections.installation_id, installationId),
            eq(emailZoneConnections.account_id, zone.account.id),
            eq(emailZoneConnections.zone_id, zone.id),
          ),
        )
        .for('update')
        .limit(1)
    )[0];
    const created = !connection;
    if (connection && connection.managed_by !== 'admin') {
      throw new EmailOperationError('shared sender zone connection must be administrator-managed');
    }
    if (connection && connection.ingress_worker_name !== worker) {
      throw new EmailOperationError(
        'shared sender zone is already connected to a different ingress worker',
      );
    }
    if (!connection) {
      await tx.insert(emailCredentials).values({
        id: credentialId,
        installation_id: installationId,
        managed_by: 'admin',
        kind: 'platform',
        account_id: zone.account.id,
        zone_id: zone.id,
      });
      await tx.insert(emailZoneConnections).values({
        id: connectionId,
        installation_id: installationId,
        account_id: zone.account.id,
        zone_id: zone.id,
        zone_name: zone.name,
        managed_by: 'admin',
        credential_id: credentialId,
        ingress_worker_name: worker,
        secret_ciphertext: secret.ciphertext,
        secret_iv: secret.iv,
        secret_key_version: secret.keyVersion,
        active_secret_generation: 1,
        management_status: 'healthy',
        management_observed_at: sql`now()`,
      });
      connection = (
        await tx
          .select()
          .from(emailZoneConnections)
          .where(eq(emailZoneConnections.id, connectionId))
          .limit(1)
      )[0]!;
    }
    await tx.insert(emailDomainRoutes).values({
      id: routeId,
      domain,
      connection_id: connection.id,
      project_id: null,
      addressing: 'shared',
      managed_by: 'admin',
      desired_state: 'active',
    });
    const requestDigest = await digest({ shared: domain, connectionId: connection.id });
    await tx.insert(emailOperations).values({
      id: operationId,
      installation_id: installationId,
      connection_id: connection.id,
      route_id: routeId,
      actor_kind: 'system',
      actor_scope: 'system:shared',
      kind: 'setup',
      idempotency_key: key,
      request_digest: requestDigest,
      desired_generation: connection.desired_generation,
    });
    // Native gateway is deployed with the platform. Uploading the customer
    // relay source here would replace it and sever shared mail delivery.
    const steps = created
      ? (['catchall_ensure', 'inbound_probe', 'publish'] as const)
      : (['inbound_probe', 'publish'] as const);
    for (let i = 0; i < steps.length; i++) {
      await tx.insert(emailOperationSteps).values({
        id: generateId('estep'),
        operation_id: operationId,
        ordinal: i,
        kind: steps[i],
        resource_identity: `${connection.account_id}/${connection.zone_id}/${connection.ingress_worker_name}`,
        request_digest: await digest({
          kind: steps[i],
          connectionId: connection.id,
          generation: connection.desired_generation,
        }),
      });
    }
    return operationId;
  });
}

export async function getEmailOperation(db: DbOrTx, projectId: string, key: string) {
  const rows = await db
    .select({ operation: emailOperations, route: emailDomainRoutes })
    .from(emailOperations)
    .innerJoin(emailDomainRoutes, eq(emailOperations.route_id, emailDomainRoutes.id))
    .where(
      and(
        eq(emailDomainRoutes.project_id, projectId),
        sql`(${emailOperations.id} = ${key} OR ${emailOperations.idempotency_key} = ${key})`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function requestEmailDomainSync(
  db: Db,
  env: Bindings,
  routeId: string,
  actor: EmailActor,
  key = generateId('esync'),
): Promise<string> {
  return requestExistingOperation(db, env, routeId, actor, 'sync', key);
}
export async function requestEmailDomainRemove(
  db: Db,
  env: Bindings,
  routeId: string,
  actor: EmailActor,
  key = generateId('erem'),
): Promise<string> {
  return requestExistingOperation(db, env, routeId, actor, 'remove', key);
}
/** Stage a new zone secret. The old generation stays active until a signed
 * challenge proves the deployed Worker actually received the new value. */
export async function requestEmailSecretRotation(
  db: Db,
  env: Bindings,
  connectionId: string,
  actor: EmailActor,
  key = generateId('erot'),
): Promise<string> {
  const installationId = emailInstallationId(env);
  const actorScope =
    actor.kind === 'system' ? 'system:rotation' : `${actor.kind}:${actor.userId}:${connectionId}`;
  const requestDigest = await digest({ connectionId, kind: 'rotate_secret', actor: actor.kind });
  const prior = (
    await db
      .select()
      .from(emailOperations)
      .where(
        and(
          eq(emailOperations.installation_id, installationId),
          eq(emailOperations.actor_scope, actorScope),
          eq(emailOperations.idempotency_key, key),
        ),
      )
      .limit(1)
  )[0];
  if (prior) {
    if (prior.request_digest !== requestDigest) {
      throw new EmailOperationError('email operation key conflict');
    }
    return prior.id;
  }
  const secret = randomSecret();
  return db.transaction(async (tx) => {
    const connection = (
      await tx
        .select()
        .from(emailZoneConnections)
        .where(eq(emailZoneConnections.id, connectionId))
        .for('update')
        .limit(1)
    )[0];
    if (!connection || connection.installation_id !== installationId) {
      throw new EmailOperationError('connection not found', 404);
    }
    if (!canManageConnection(actor, connection)) {
      throw new EmailOperationError('only the connection manager can rotate ingress', 403);
    }
    if (isSharedGatewayConnection(env, connection)) {
      throw new EmailOperationError(
        'the installation gateway secret is managed by platform deployment, not zone rotation',
        409,
      );
    }
    if (connection.staged_secret_generation !== null) {
      throw new EmailOperationError('ingress rotation already staged');
    }
    const unresolved = (
      await tx
        .select({ id: emailOperations.id })
        .from(emailOperations)
        .where(
          and(
            eq(emailOperations.connection_id, connectionId),
            inArray(emailOperations.status, ['pending', 'running', 'unknown']),
          ),
        )
        .limit(1)
    )[0];
    if (unresolved) {
      throw new EmailOperationError(`connection operation ${unresolved.id} is unresolved`);
    }
    const generation = connection.desired_generation + 1,
      secretGeneration = connection.active_secret_generation + 1;
    const encrypted = await encryptPlatformCredential(
      env,
      installationId,
      `${connection.id}:secret:${secretGeneration}`,
      secret,
    );
    await tx
      .update(emailZoneConnections)
      .set({
        desired_generation: generation,
        staged_secret_generation: secretGeneration,
        staged_secret_ciphertext: encrypted.ciphertext,
        staged_secret_iv: encrypted.iv,
        staged_secret_key_version: encrypted.keyVersion,
        updated_at: sql`now()`,
      })
      .where(eq(emailZoneConnections.id, connectionId));
    const operationId = generateId('eop');
    await tx.insert(emailOperations).values({
      id: operationId,
      installation_id: installationId,
      connection_id: connectionId,
      actor_kind: actor.kind,
      actor_user_id: actor.kind === 'system' ? null : actor.userId,
      actor_scope: actorScope,
      kind: 'rotate_secret',
      idempotency_key: key,
      request_digest: requestDigest,
      desired_generation: generation,
    });
    for (let i = 0; i < ROTATE_STEPS.length; i++) {
      await tx.insert(emailOperationSteps).values({
        id: generateId('estep'),
        operation_id: operationId,
        ordinal: i,
        kind: ROTATE_STEPS[i],
        resource_identity: `${connection.account_id}/${connection.zone_id}/${connection.ingress_worker_name}/secret/${secretGeneration}`,
        request_digest: await digest({
          kind: ROTATE_STEPS[i],
          connectionId,
          generation,
          secretGeneration,
        }),
      });
    }
    return operationId;
  });
}
async function requestExistingOperation(
  db: Db,
  env: Bindings,
  routeId: string,
  actor: EmailActor,
  kind: 'sync' | 'remove',
  key: string,
): Promise<string> {
  const installationId = emailInstallationId(env);
  const actorScope =
    actor.kind === 'system' ? 'system' : `${actor.kind}:${actor.userId}:${routeId}`;
  const requestDigest = await digest({ routeId, kind, actor: actor.kind });
  const existing = (
    await db
      .select()
      .from(emailOperations)
      .where(
        and(
          eq(emailOperations.installation_id, installationId),
          eq(emailOperations.actor_scope, actorScope),
          eq(emailOperations.idempotency_key, key),
        ),
      )
      .limit(1)
  )[0];
  if (existing) {
    if (existing.request_digest !== requestDigest) {
      throw new EmailOperationError('email operation key conflict');
    }
    return existing.id;
  }
  return db.transaction(async (tx) => {
    if (kind === 'remove') {
      await disableEmailDomainRouteAndDrainTx(tx, routeId);
    }
    const route = (
      await tx
        .select()
        .from(emailDomainRoutes)
        .where(eq(emailDomainRoutes.id, routeId))
        .for('update')
        .limit(1)
    )[0];
    if (!route) {
      throw new EmailOperationError('email domain not available', 404);
    }
    const connection = (
      await tx
        .select()
        .from(emailZoneConnections)
        .where(eq(emailZoneConnections.id, route.connection_id))
        .for('update')
        .limit(1)
    )[0];
    const project = route.project_id
      ? (await tx.select().from(projects).where(eq(projects.id, route.project_id)).limit(1))[0]
      : null;
    if (!connection || (actor.kind !== 'system' && (!project || project.status === 'deleting'))) {
      throw new EmailOperationError('email domain not available', 404);
    }
    if (
      actor.kind === 'owner' &&
      (project?.user_id !== actor.userId || route.managed_by !== 'owner')
    ) {
      throw new EmailOperationError('forbidden', 403);
    }
    if (kind === 'sync' && !canManageConnection(actor, connection)) {
      throw new EmailOperationError(
        'only the connection manager can reconcile shared ingress',
        403,
      );
    }
    const existingRemoval =
      kind === 'remove'
        ? (
            await tx
              .select({ id: emailOperations.id })
              .from(emailOperations)
              .where(
                and(
                  eq(emailOperations.route_id, routeId),
                  eq(emailOperations.kind, 'remove'),
                  inArray(emailOperations.status, ['pending', 'running', 'unknown']),
                ),
              )
              .orderBy(emailOperations.created_at, emailOperations.id)
              .limit(1)
          )[0]
        : null;
    if (existingRemoval) {
      return existingRemoval.id;
    }
    const unresolved = (
      await tx
        .select()
        .from(emailOperations)
        .where(
          and(
            eq(emailOperations.connection_id, connection.id),
            inArray(emailOperations.status, ['pending', 'running', 'unknown']),
          ),
        )
        .orderBy(desc(emailOperations.created_at), desc(emailOperations.id))
        .limit(1)
    )[0];
    if (unresolved && kind !== 'remove') {
      throw new EmailOperationError(`connection operation ${unresolved.id} is unresolved`);
    }
    const opId = generateId('eop');
    const generation = unresolved
      ? connection.desired_generation
      : connection.desired_generation + 1;
    if (!unresolved) {
      await tx
        .update(emailZoneConnections)
        .set({ desired_generation: generation, updated_at: sql`now()` })
        .where(eq(emailZoneConnections.id, connection.id));
    }
    await tx.insert(emailOperations).values({
      id: opId,
      installation_id: installationId,
      connection_id: connection.id,
      route_id: routeId,
      actor_kind: actor.kind,
      actor_user_id: actor.kind === 'system' ? null : actor.userId,
      actor_scope: actorScope,
      kind,
      idempotency_key: key,
      request_digest: requestDigest,
      desired_generation: generation,
      current_step: unresolved && kind === 'remove' ? `wait:${unresolved.id}` : null,
    });
    const steps =
      kind === 'sync'
        ? isSharedGatewayConnection(env, connection)
          ? SHARED_SYNC_STEPS
          : SYNC_STEPS
        : REMOVE_STEPS;
    for (let i = 0; i < steps.length; i++) {
      await tx.insert(emailOperationSteps).values({
        id: generateId('estep'),
        operation_id: opId,
        ordinal: i,
        kind: steps[i],
        resource_identity: `${connection.account_id}/${connection.zone_id}/${connection.ingress_worker_name}`,
        request_digest: await digest({
          kind: steps[i],
          connectionId: connection.id,
          generation,
        }),
      });
    }
    return opId;
  });
}

/** Bounded synchronous driver. Cron calls this too, so a lost HTTP response cannot strand setup. */
export async function runEmailOperation(db: Db, env: Bindings, operationId: string): Promise<void> {
  for (let iteration = 0; iteration < 12; iteration++) {
    const claim = await db.transaction(async (tx) => {
      const op = (
        await tx
          .select()
          .from(emailOperations)
          .where(eq(emailOperations.id, operationId))
          .for('update')
          .limit(1)
      )[0];
      if (!op || op.status === 'completed' || op.status === 'blocked' || op.status === 'unknown') {
        return null;
      }
      if (op.kind === 'remove') {
        // Removal intents form a durable chain. A later sibling removal may
        // wait for this one, but must never stop it from making progress.
        const predecessorId = op.current_step?.startsWith('wait:')
          ? op.current_step.slice(5)
          : null;
        if (predecessorId) {
          const predecessor = (
            await tx
              .select({ status: emailOperations.status })
              .from(emailOperations)
              .where(eq(emailOperations.id, predecessorId))
              .limit(1)
          )[0];
          if (
            predecessor &&
            (predecessor.status === 'pending' ||
              predecessor.status === 'running' ||
              predecessor.status === 'unknown')
          ) {
            return null;
          }
        }
      }
      const connection = (
        await tx
          .select()
          .from(emailZoneConnections)
          .where(eq(emailZoneConnections.id, op.connection_id))
          .for('update')
          .limit(1)
      )[0];
      if (!connection || connection.desired_generation !== op.desired_generation) {
        throw new EmailOperationError('email operation generation changed');
      }
      const steps = await tx
        .select()
        .from(emailOperationSteps)
        .where(eq(emailOperationSteps.operation_id, operationId))
        .orderBy(emailOperationSteps.ordinal);
      const step = steps.find((s) => s.status !== 'confirmed');
      if (!step) {
        await tx
          .update(emailOperations)
          .set({ status: 'completed', current_step: null, updated_at: sql`now()` })
          .where(eq(emailOperations.id, operationId));
        return null;
      }
      if (step.status === 'in_flight') {
        // A second scheduler must leave the current driver alone. A crashed
        // driver is fenced only after its lease ages out; its provider write
        // is never replayed merely because the lease expired.
        if (step.started_at && Date.now() - Date.parse(step.started_at) < 5 * 60_000) {
          return null;
        }
        await tx
          .update(emailOperationSteps)
          .set({ status: 'unknown', failure_code: 'outcome_unknown' })
          .where(
            and(
              eq(emailOperationSteps.id, step.id),
              eq(emailOperationSteps.status, 'in_flight'),
              eq(emailOperationSteps.attempt, step.attempt),
            ),
          );
        await tx
          .update(emailOperations)
          .set({
            status: 'unknown',
            current_step: step.kind,
            failure_code: 'outcome_unknown',
            updated_at: sql`now()`,
          })
          .where(eq(emailOperations.id, operationId));
        return null;
      }
      if (step.status === 'unknown') {
        return null;
      }
      if (step.status === 'blocked') {
        return null;
      }
      if (
        op.kind === 'remove' &&
        (step.kind === 'catchall_detach' || step.kind === 'ingress_delete') &&
        op.route_id
      ) {
        const [route] = await tx
          .select({ projectId: emailDomainRoutes.project_id, domain: emailDomainRoutes.domain })
          .from(emailDomainRoutes)
          .where(eq(emailDomainRoutes.id, op.route_id))
          .limit(1);
        if (route?.projectId) {
          const [active] = await tx
            .select({ n: count() })
            .from(emailUnresolvedAttempts)
            .where(
              and(
                eq(emailUnresolvedAttempts.project_id, route.projectId),
                eq(emailUnresolvedAttempts.sender_domain, route.domain),
              ),
            );
          if ((active?.n ?? 0) > 0) {
            return null;
          }
        }
      }
      await tx
        .update(emailOperationSteps)
        .set({ status: 'in_flight', attempt: step.attempt + 1, started_at: sql`now()` })
        .where(eq(emailOperationSteps.id, step.id));
      await tx
        .update(emailOperations)
        .set({ status: 'running', current_step: step.kind, updated_at: sql`now()` })
        .where(eq(emailOperations.id, operationId));
      return { op, connection, step, attempt: step.attempt + 1 };
    });
    if (!claim) {
      return;
    }
    try {
      const outcome = await executeEmailStep(
        db,
        env,
        claim.op,
        claim.connection,
        claim.step.kind as StepKind,
      );
      await db.transaction(async (tx) => {
        const current = (
          await tx
            .select()
            .from(emailZoneConnections)
            .where(eq(emailZoneConnections.id, claim.connection.id))
            .for('update')
            .limit(1)
        )[0];
        if (!current || current.desired_generation !== claim.op.desired_generation) {
          return;
        }
        const updated = await tx
          .update(emailOperationSteps)
          .set({
            status: 'confirmed',
            outcome,
            failure_code: null,
            failure_detail: null,
            finished_at: sql`now()`,
          })
          .where(
            and(
              eq(emailOperationSteps.id, claim.step.id),
              eq(emailOperationSteps.attempt, claim.attempt),
              inArray(emailOperationSteps.status, ['in_flight', 'unknown']),
            ),
          )
          .returning({ id: emailOperationSteps.id });
        if (updated.length) {
          await tx
            .update(emailOperations)
            .set({
              status: 'pending',
              failure_code: null,
              failure_detail: null,
              updated_at: sql`now()`,
            })
            .where(
              and(
                eq(emailOperations.id, operationId),
                inArray(emailOperations.status, ['running', 'unknown']),
              ),
            );
        }
      });
    } catch (error) {
      // A write may have reached Cloudflare even if fetch failed. Stop until
      // an explicit probe or operator decision establishes its outcome.
      const detail = error instanceof Error ? error.message : String(error);
      const blocked = error instanceof EmailOperationError && error.status < 500;
      const status = blocked ? 'blocked' : 'unknown';
      await db.transaction(async (tx) => {
        const updated = await tx
          .update(emailOperationSteps)
          .set({
            status,
            failure_code: blocked ? 'blocked' : 'outcome_unknown',
            failure_detail: detail.slice(0, 300),
            finished_at: sql`now()`,
          })
          .where(
            and(
              eq(emailOperationSteps.id, claim.step.id),
              eq(emailOperationSteps.attempt, claim.attempt),
              inArray(emailOperationSteps.status, ['in_flight', 'unknown']),
            ),
          )
          .returning({ id: emailOperationSteps.id });
        if (updated.length) {
          await tx
            .update(emailOperations)
            .set({
              status,
              current_step: claim.step.kind,
              failure_code: blocked ? 'blocked' : 'outcome_unknown',
              failure_detail: detail.slice(0, 300),
              updated_at: sql`now()`,
            })
            .where(
              and(
                eq(emailOperations.id, operationId),
                inArray(emailOperations.status, ['running', 'unknown']),
              ),
            );
        }
      });
      return;
    }
  }
}

async function executeEmailStep(
  db: Db,
  env: Bindings,
  op: typeof emailOperations.$inferSelect,
  connection: typeof emailZoneConnections.$inferSelect,
  kind: StepKind,
): Promise<Record<string, unknown>> {
  const route = op.route_id
    ? (
        await db
          .select()
          .from(emailDomainRoutes)
          .where(eq(emailDomainRoutes.id, op.route_id))
          .limit(1)
      )[0]
    : null;
  if (kind === 'route_disable') {
    return { disabled: true };
  }
  if (kind === 'publish') {
    if (route) {
      await db.transaction(async (tx) => {
        if (op.kind === 'remove') {
          await tx
            .update(emailDomainRoutes)
            .set({ desired_state: 'removed', inbound_status: 'disabled', updated_at: sql`now()` })
            .where(eq(emailDomainRoutes.id, route.id));
        }
        const state = op.kind === 'remove' ? 'removed' : route.desired_state;
        await tx
          .insert(emailCacheOutbox)
          .values({
            id: generateId('eout'),
            installation_id: connection.installation_id,
            resource_kind: 'route',
            resource_id: route.id,
            version: route.desired_generation,
            payload: { domain: route.domain, status: state, connectionId: connection.id },
          })
          .onConflictDoNothing();
      });
    }
    return { published: false, queued: true };
  }
  const credential = await credentialFor(env, db, connection);
  const client = createCfCustomerClient(credential);
  if (kind === 'routing_enable') {
    if (!route) {
      throw new EmailOperationError('route is unavailable');
    }
    const subdomain = route.domain !== connection.zone_name;
    await client.enableRouting(connection.zone_id, subdomain ? route.domain : undefined);
    return { domain: route.domain };
  }
  if (kind === 'ingress_deploy') {
    await client.putRelayScript(connection.account_id, connection.ingress_worker_name, {
      source: RELAY_SOURCE,
      compatibilityDate: RELAY_COMPATIBILITY_DATE,
      gatewayOrigin: gatewayOrigin(env),
      accountId: connection.account_id,
      zoneId: connection.zone_id,
      ingressName: connection.ingress_worker_name,
    });
    await db
      .update(emailZoneConnections)
      .set({ ingress_version: RELAY_VERSION, updated_at: sql`now()` })
      .where(
        and(
          eq(emailZoneConnections.id, connection.id),
          eq(emailZoneConnections.desired_generation, op.desired_generation),
        ),
      );
    return { version: RELAY_VERSION };
  }
  if (kind === 'probe_route_enable') {
    if (
      !(await client.getScriptSubdomainEnabled(
        connection.account_id,
        connection.ingress_worker_name,
      ))
    ) {
      await client.enableScriptSubdomain(connection.account_id, connection.ingress_worker_name);
    }
    return { enabled: true };
  }
  if (kind === 'secret_put') {
    const staged = op.kind === 'rotate_secret';
    const secret = staged
      ? await readStagedConnectionSecret(env, connection)
      : await readConnectionSecret(env, connection);
    await client.putRelaySecret(connection.account_id, connection.ingress_worker_name, secret);
    return {
      generation: staged
        ? connection.staged_secret_generation
        : connection.active_secret_generation,
    };
  }
  if (kind === 'relay_probe') {
    return probeDeployedRelay(client, env, connection, op.kind === 'rotate_secret');
  }
  if (kind === 'gateway_probe') {
    return probeGatewayAcceptance(env, connection, op.kind === 'rotate_secret');
  }
  if (kind === 'secret_promote') {
    if (
      op.kind !== 'rotate_secret' ||
      connection.staged_secret_generation === null ||
      !connection.staged_secret_ciphertext ||
      !connection.staged_secret_iv ||
      !connection.staged_secret_key_version
    ) {
      throw new EmailOperationError('staged ingress generation unavailable');
    }
    const oldSecret = await readConnectionSecret(env, connection);
    const oldHash = await digest(oldSecret);
    const promoted = await db
      .update(emailZoneConnections)
      .set({
        active_secret_generation: connection.staged_secret_generation,
        secret_ciphertext: connection.staged_secret_ciphertext,
        secret_iv: connection.staged_secret_iv,
        secret_key_version: connection.staged_secret_key_version,
        staged_secret_generation: null,
        staged_secret_ciphertext: null,
        staged_secret_iv: null,
        staged_secret_key_version: null,
        previous_secret_hash: oldHash,
        previous_secret_until: sql`now() + interval '10 minutes'`,
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(emailZoneConnections.id, connection.id),
          eq(emailZoneConnections.desired_generation, op.desired_generation),
          eq(emailZoneConnections.staged_secret_generation, connection.staged_secret_generation),
        ),
      )
      .returning({ id: emailZoneConnections.id });
    if (!promoted.length) {
      throw new EmailOperationError('secret promotion lost its generation fence', 503);
    }
    return { generation: connection.staged_secret_generation };
  }
  if (kind === 'catchall_ensure') {
    const current = await client.getCatchAll(connection.zone_id);
    if (current?.enabled && current.workerName !== connection.ingress_worker_name) {
      throw new EmailOperationError('another enabled catch-all owns this zone');
    }
    if (!current?.enabled) {
      await client.setCatchAll(connection.zone_id, connection.ingress_worker_name);
    }
    return { workerName: connection.ingress_worker_name };
  }
  if (kind === 'inbound_probe') {
    const current = await client.getCatchAll(connection.zone_id);
    if (!current?.enabled || current.workerName !== connection.ingress_worker_name) {
      throw new EmailOperationError('zone catch-all does not point to this ingress');
    }
    await db.transaction(async (tx) => {
      await tx
        .update(emailZoneConnections)
        .set({ inbound_status: 'ready', inbound_reason: null, inbound_observed_at: sql`now()` })
        .where(
          and(
            eq(emailZoneConnections.id, connection.id),
            eq(emailZoneConnections.desired_generation, op.desired_generation),
          ),
        );
      if (route && route.desired_state === 'active') {
        await tx
          .update(emailDomainRoutes)
          .set({ inbound_status: 'ready', inbound_reason: null, inbound_observed_at: sql`now()` })
          .where(eq(emailDomainRoutes.id, route.id));
      }
    });
    return { ready: true };
  }
  if (kind === 'sending_onboard') {
    if (!route || route.desired_state !== 'active') {
      return { skipped: true };
    }
    try {
      await client.onboardSending(connection.zone_id, route.domain);
    } catch {
      if (!(await sendingOnboardedReadback(client, connection.zone_id, route.domain))) {
        await db
          .update(emailDomainRoutes)
          .set({
            outbound_status: 'verified_only',
            outbound_reason: 'Cloudflare Sending onboarding unavailable',
            outbound_observed_at: sql`now()`,
          })
          .where(eq(emailDomainRoutes.id, route.id));
        return { verifiedOnly: true };
      }
    }
    await db
      .update(emailDomainRoutes)
      .set({ outbound_status: 'ready', outbound_reason: null, outbound_observed_at: sql`now()` })
      .where(eq(emailDomainRoutes.id, route.id));
    return { ready: true };
  }
  if (kind === 'catchall_detach' || kind === 'ingress_delete') {
    // Every non-removed sibling, including a disabled assignment awaiting
    // reconciliation, retains the shared zone resources. This check is
    // repeated at each destructive provider step.
    const sibling = (
      await db
        .select({ id: emailDomainRoutes.id })
        .from(emailDomainRoutes)
        .where(
          and(
            eq(emailDomainRoutes.connection_id, connection.id),
            ne(emailDomainRoutes.desired_state, 'removed'),
            ...(route ? [ne(emailDomainRoutes.id, route.id)] : []),
          ),
        )
        .limit(1)
    )[0];
    if (sibling) {
      return { retainedForSibling: true };
    }
    if (
      !canManageConnection(
        { kind: op.actor_kind, userId: op.actor_user_id ?? '' } as EmailActor,
        connection,
      )
    ) {
      return { retainedForManager: true };
    }
    if (kind === 'catchall_detach') {
      const current = await client.getCatchAll(connection.zone_id);
      if (current?.enabled && current.workerName === connection.ingress_worker_name) {
        await client.resetCatchAll(connection.zone_id);
      }
      return { detached: true };
    }
    const current = await client.getCatchAll(connection.zone_id);
    if (current?.enabled && current.workerName === connection.ingress_worker_name) {
      throw new EmailOperationError('owned catch-all still targets ingress');
    }
    await client.deleteRelayScript(connection.account_id, connection.ingress_worker_name);
    await db
      .update(emailZoneConnections)
      .set({ inbound_status: 'disabled', inbound_observed_at: sql`now()` })
      .where(eq(emailZoneConnections.id, connection.id));
    return { deleted: true };
  }
  throw new EmailOperationError(`unsupported email step: ${kind}`);
}

export async function reconcilePendingEmailOperations(
  db: Db,
  env: Bindings,
  limit = 10,
): Promise<number> {
  const rows = await db
    .select({ id: emailOperations.id, status: emailOperations.status })
    .from(emailOperations)
    .where(inArray(emailOperations.status, ['pending', 'running', 'unknown']))
    .orderBy(emailOperations.created_at)
    .limit(limit);
  for (const row of rows) {
    if (row.status === 'unknown') {
      await reconcileUnknownEmailOperation(db, env, row.id);
    }
    await runEmailOperation(db, env, row.id);
  }
  return rows.length;
}

/** Read-only recovery for ambiguous provider writes. A result is confirmed
 * only where the currently observed resource proves this exact step's intent.
 * Script upload and routing enable remain unknown without that proof. */
export async function reconcileUnknownEmailOperation(
  db: Db,
  env: Bindings,
  operationId: string,
): Promise<boolean> {
  const op = (
    await db.select().from(emailOperations).where(eq(emailOperations.id, operationId)).limit(1)
  )[0];
  if (!op || op.status !== 'unknown') {
    return false;
  }
  const connection = (
    await db
      .select()
      .from(emailZoneConnections)
      .where(eq(emailZoneConnections.id, op.connection_id))
      .limit(1)
  )[0];
  if (!connection || connection.desired_generation !== op.desired_generation) {
    return false;
  }
  const step = (
    await db
      .select()
      .from(emailOperationSteps)
      .where(
        and(
          eq(emailOperationSteps.operation_id, operationId),
          eq(emailOperationSteps.status, 'unknown'),
        ),
      )
      .orderBy(emailOperationSteps.ordinal)
      .limit(1)
  )[0];
  if (!step) {
    return false;
  }
  let outcome: Record<string, unknown> | null = null;
  try {
    if (step.kind === 'route_disable') {
      const route = op.route_id
        ? (
            await db
              .select()
              .from(emailDomainRoutes)
              .where(eq(emailDomainRoutes.id, op.route_id))
              .limit(1)
          )[0]
        : null;
      if (route?.desired_state === 'disabled') {
        outcome = { disabled: true };
      }
    } else if (step.kind === 'secret_promote') {
      const target = Number(step.resource_identity.split('/secret/')[1]);
      if (
        Number.isInteger(target) &&
        connection.staged_secret_generation === null &&
        connection.active_secret_generation === target
      ) {
        outcome = { generation: connection.active_secret_generation };
      }
    } else if (step.kind === 'publish') {
      const route = op.route_id
        ? (
            await db
              .select()
              .from(emailDomainRoutes)
              .where(eq(emailDomainRoutes.id, op.route_id))
              .limit(1)
          )[0]
        : null;
      const outbox = route
        ? (
            await db
              .select({ id: emailCacheOutbox.id })
              .from(emailCacheOutbox)
              .where(
                and(
                  eq(emailCacheOutbox.resource_kind, 'route'),
                  eq(emailCacheOutbox.resource_id, route.id),
                  eq(emailCacheOutbox.version, route.desired_generation),
                ),
              )
              .limit(1)
          )[0]
        : null;
      if (outbox || op.kind === 'rotate_secret') {
        outcome = { queued: true };
      }
    } else {
      const client = createCfCustomerClient(await credentialFor(env, db, connection));
      if (step.kind === 'probe_route_enable') {
        if (
          await client.getScriptSubdomainEnabled(
            connection.account_id,
            connection.ingress_worker_name,
          )
        ) {
          outcome = { enabled: true };
        }
      } else if (step.kind === 'secret_put' || step.kind === 'relay_probe') {
        outcome = await probeDeployedRelay(client, env, connection, op.kind === 'rotate_secret');
      } else if (step.kind === 'gateway_probe') {
        outcome = await probeGatewayAcceptance(env, connection, op.kind === 'rotate_secret');
      } else if (step.kind === 'catchall_ensure' || step.kind === 'inbound_probe') {
        const catchall = await client.getCatchAll(connection.zone_id);
        if (catchall?.enabled && catchall.workerName === connection.ingress_worker_name) {
          outcome = { workerName: connection.ingress_worker_name };
        }
      } else if (step.kind === 'catchall_detach') {
        const catchall = await client.getCatchAll(connection.zone_id);
        if (!catchall?.enabled || catchall.workerName !== connection.ingress_worker_name) {
          outcome = { detached: true };
        }
      } else if (step.kind === 'ingress_delete') {
        if (
          !(await client.relayScriptExists(connection.account_id, connection.ingress_worker_name))
        ) {
          outcome = { deleted: true };
        }
      } else if (step.kind === 'sending_onboard') {
        const route = op.route_id
          ? (
              await db
                .select()
                .from(emailDomainRoutes)
                .where(eq(emailDomainRoutes.id, op.route_id))
                .limit(1)
            )[0]
          : null;
        if (route && (await sendingOnboardedReadback(client, connection.zone_id, route.domain))) {
          outcome = { ready: true };
        }
      }
    }
  } catch {
    return false;
  }
  if (!outcome) {
    return false;
  }
  return db.transaction(async (tx) => {
    const current = (
      await tx
        .select()
        .from(emailZoneConnections)
        .where(eq(emailZoneConnections.id, connection.id))
        .for('update')
        .limit(1)
    )[0];
    if (!current || current.desired_generation !== op.desired_generation) {
      return false;
    }
    const updated = await tx
      .update(emailOperationSteps)
      .set({
        status: 'confirmed',
        outcome,
        failure_code: null,
        failure_detail: null,
        finished_at: sql`now()`,
      })
      .where(
        and(
          eq(emailOperationSteps.id, step.id),
          eq(emailOperationSteps.status, 'unknown'),
          eq(emailOperationSteps.attempt, step.attempt),
        ),
      )
      .returning({ id: emailOperationSteps.id });
    if (!updated.length) {
      return false;
    }
    if (step.kind === 'inbound_probe') {
      await tx
        .update(emailZoneConnections)
        .set({ inbound_status: 'ready', inbound_reason: null, inbound_observed_at: sql`now()` })
        .where(eq(emailZoneConnections.id, connection.id));
      if (op.route_id) {
        await tx
          .update(emailDomainRoutes)
          .set({ inbound_status: 'ready', inbound_reason: null, inbound_observed_at: sql`now()` })
          .where(
            and(
              eq(emailDomainRoutes.id, op.route_id),
              eq(emailDomainRoutes.desired_state, 'active'),
            ),
          );
      }
    }
    if (step.kind === 'sending_onboard' && op.route_id) {
      await tx
        .update(emailDomainRoutes)
        .set({ outbound_status: 'ready', outbound_reason: null, outbound_observed_at: sql`now()` })
        .where(eq(emailDomainRoutes.id, op.route_id));
    }
    await tx
      .update(emailOperations)
      .set({ status: 'pending', failure_code: null, failure_detail: null, updated_at: sql`now()` })
      .where(and(eq(emailOperations.id, operationId), eq(emailOperations.status, 'unknown')));
    return true;
  });
}

/** Serialized cache publication. Versioned values are immutable; the mutable
 * pointer is for display only and never authorizes mail. */
export async function flushEmailCacheOutbox(db: Db, kv: KVNamespace, limit = 25): Promise<number> {
  const rows = await db
    .select()
    .from(emailCacheOutbox)
    .where(isNull(emailCacheOutbox.published_at))
    .orderBy(emailCacheOutbox.created_at, emailCacheOutbox.id)
    .limit(limit);
  let count = 0;
  for (const row of rows) {
    const newest = (
      await db
        .select({ version: emailCacheOutbox.version })
        .from(emailCacheOutbox)
        .where(
          and(
            eq(emailCacheOutbox.resource_kind, row.resource_kind),
            eq(emailCacheOutbox.resource_id, row.resource_id),
          ),
        )
        .orderBy(sql`${emailCacheOutbox.version} DESC`)
        .limit(1)
    )[0];
    if (newest?.version === row.version) {
      const base = `email-cache:${row.resource_kind}:${row.resource_id}`;
      await kv.put(`${base}:v${row.version}`, JSON.stringify(row.payload));
      // This mutable pointer is never security authority. Out-of-order
      // publication may make display stale until a later refresh.
      await kv.put(`${base}:latest`, String(row.version));
    }
    await db
      .update(emailCacheOutbox)
      .set({ published_at: sql`now()` })
      .where(eq(emailCacheOutbox.id, row.id));
    count++;
  }
  return count;
}
