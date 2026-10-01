import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { generateId } from '../id.ts';
import { CloudflareApiError } from '../provisioning/cloudflare-api.ts';
import { projects } from '../schema.ts';
import { createCfCustomerClient, type CfEmailRoutingRule } from './cf-customer.ts';
import {
  emailDomainRoutes,
  emailSharedRecipients,
  emailZoneConnections,
} from './connection-schema.ts';
import {
  credentialFor,
  EmailOperationError,
  emailInstallationId,
  inspectEmailInboundRoute,
} from './connection-service.ts';

type Bindings = ApiEnv['Bindings'];
type Recipient = typeof emailSharedRecipients.$inferSelect;
const LEASE_MS = 15 * 60_000;

async function sharedRoute(db: Db, env: Bindings) {
  if (!env.EMAIL_SENDER_DOMAIN) {
    return null;
  }
  const [row] = await db
    .select()
    .from(emailDomainRoutes)
    .innerJoin(emailZoneConnections, eq(emailZoneConnections.id, emailDomainRoutes.connection_id))
    .where(
      and(
        eq(emailDomainRoutes.domain, env.EMAIL_SENDER_DOMAIN.toLowerCase()),
        eq(emailDomainRoutes.addressing, 'shared'),
        eq(emailDomainRoutes.desired_state, 'active'),
      ),
    )
    .limit(1);
  if (!row) {
    return null;
  }
  const connection = row.email_zone_connections;
  const configured = env as Bindings & {
    EMAIL_SHARED_ACCOUNT_ID?: string;
    EMAIL_SHARED_ZONE_ID?: string;
    EMAIL_SHARED_INGRESS_NAME?: string;
  };
  if (
    connection.installation_id !== emailInstallationId(env) ||
    connection.account_id !== env.CF_ACCOUNT_ID ||
    connection.account_id !== configured.EMAIL_SHARED_ACCOUNT_ID ||
    connection.zone_id !== configured.EMAIL_SHARED_ZONE_ID ||
    connection.ingress_worker_name !== configured.EMAIL_SHARED_INGRESS_NAME ||
    connection.managed_by !== 'admin'
  ) {
    throw new EmailOperationError(
      'shared email ingress identity does not match this installation',
      503,
    );
  }
  return { route: row.email_domain_routes, connection };
}

export function isOwnedSharedRecipientRule(
  rule: CfEmailRoutingRule,
  row: Pick<Recipient, 'rule_id' | 'rule_name' | 'recipient'>,
  worker: string,
) {
  return Boolean(
    rule.id &&
    (!row.rule_id || rule.id === row.rule_id) &&
    rule.name === row.rule_name &&
    rule.literalWorker &&
    rule.workerName === worker &&
    rule.addresses.length === 1 &&
    rule.addresses[0] === row.recipient,
  );
}

function ruleConflicts(rule: CfEmailRoutingRule, recipient: string) {
  const at = recipient.lastIndexOf('@');
  const local = recipient.slice(0, at),
    domain = recipient.slice(at + 1);
  return rule.addresses.some((address) => {
    const split = address.lastIndexOf('@');
    return (
      address.slice(split + 1) === domain && address.slice(0, split).split('+', 1)[0] === local
    );
  });
}

async function ownershipName(installation: string, projectId: string, recipient: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([installation, projectId, recipient])),
  );
  return `void-shared-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function failureReason(error: unknown) {
  if (error instanceof EmailOperationError) {
    return error.message;
  }
  if (error instanceof CloudflareApiError && error.status === 403) {
    return 'Cloudflare denied shared recipient management; grant Email Routing Rules Write and Zone Settings Write';
  }
  if (
    error instanceof CloudflareApiError &&
    (error.status === 409 || /limit|maximum|capacity/i.test(error.message))
  ) {
    return 'Cloudflare could not allocate an Email Routing rule; remove unused rules or review the Email Routing limits at https://developers.cloudflare.com/email-service/platform/limits/';
  }
  return 'Cloudflare shared recipient routing could not be verified; retry reconciliation';
}

async function finish(
  db: Db,
  row: Recipient,
  values: Partial<typeof emailSharedRecipients.$inferInsert>,
) {
  const rows = await db
    .update(emailSharedRecipients)
    .set({ ...values, lease_started_at: null, observed_at: sql`now()`, updated_at: sql`now()` })
    .where(
      and(
        eq(emailSharedRecipients.id, row.id),
        eq(emailSharedRecipients.attempt, row.attempt),
        eq(emailSharedRecipients.status, 'reconciling'),
        eq(emailSharedRecipients.removing, row.removing),
      ),
    )
    .returning({ id: emailSharedRecipients.id });
  return rows.length === 1;
}

/** Provider reads can outlive a lease. Renew only the exact current claim;
 * a zero-row CAS must stop before any provider write or ownership checkpoint. */
async function renewClaim(
  db: Db,
  row: Recipient,
  values: Partial<typeof emailSharedRecipients.$inferInsert> = {},
) {
  const rows = await db
    .update(emailSharedRecipients)
    .set({ ...values, lease_started_at: sql`now()`, updated_at: sql`now()` })
    .where(
      and(
        eq(emailSharedRecipients.id, row.id),
        eq(emailSharedRecipients.attempt, row.attempt),
        eq(emailSharedRecipients.status, 'reconciling'),
        eq(emailSharedRecipients.removing, row.removing),
      ),
    )
    .returning({ id: emailSharedRecipients.id });
  return rows.length === 1;
}

/** No transaction spans provider I/O. The project lock fences teardown and slug reuse. */
export async function reconcileSharedEmailRecipient(
  db: Db,
  env: Bindings,
  projectId: string,
): Promise<void> {
  const shared = await sharedRoute(db, env);
  if (!shared) {
    return;
  }
  const project = (await db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  if (!project || project.status !== 'active') {
    return;
  }
  const recipient = `${project.slug}@${shared.route.domain}`;
  await removeSharedEmailRecipients(db, env, projectId, recipient);
  const name = await ownershipName(shared.connection.installation_id, projectId, recipient);
  const claimed = await db.transaction(async (tx) => {
    const [lockedProject] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .for('update');
    if (
      !lockedProject ||
      lockedProject.status !== 'active' ||
      lockedProject.slug !== project.slug
    ) {
      return null;
    }
    await tx
      .insert(emailSharedRecipients)
      .values({
        id: generateId('erec'),
        installation_id: shared.connection.installation_id,
        project_id: projectId,
        route_id: shared.route.id,
        recipient,
        rule_name: name,
      })
      .onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(emailSharedRecipients)
      .where(
        and(
          eq(emailSharedRecipients.installation_id, shared.connection.installation_id),
          eq(emailSharedRecipients.project_id, projectId),
          eq(emailSharedRecipients.recipient, recipient),
        ),
      )
      .for('update');
    if (
      !row ||
      row.removing ||
      row.status === 'removed' ||
      (row.status === 'reconciling' &&
        Date.parse(row.lease_started_at ?? '') > Date.now() - LEASE_MS)
    ) {
      return null;
    }
    const [claimedRow] = await tx
      .update(emailSharedRecipients)
      .set({
        status: 'reconciling',
        attempt: row.attempt + 1,
        lease_started_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where(eq(emailSharedRecipients.id, row.id))
      .returning();
    return claimedRow!;
  });
  if (!claimed) {
    return;
  }
  let row = claimed;
  try {
    // Record the refusal so scheduled repair remains fair even for long names.
    if (recipient.length > 90) {
      throw new EmailOperationError(
        'Shared email address exceeds Cloudflare’s 90-character routing-rule limit; use a shorter project slug or shared mail domain',
        400,
      );
    }
    const client = createCfCustomerClient(await credentialFor(env, db, shared.connection));
    const domainIssue = await inspectEmailInboundRoute(
      client,
      shared.connection,
      shared.route.domain,
      'shared',
    );
    if (domainIssue) {
      throw new EmailOperationError(domainIssue);
    }
    const rules = await client.listRoutingRules(shared.connection.zone_id);
    const named = rules.filter((rule) => rule.name === row.rule_name);
    if (
      named.length > 1 ||
      named.some(
        (rule) => !isOwnedSharedRecipientRule(rule, row, shared.connection.ingress_worker_name),
      )
    ) {
      throw new EmailOperationError(
        'Shared recipient rule ownership changed; restore the recorded rule before reconciliation',
      );
    }
    if (
      rules.some(
        (rule) =>
          ruleConflicts(rule, recipient) &&
          !isOwnedSharedRecipientRule(rule, row, shared.connection.ingress_worker_name),
      )
    ) {
      throw new EmailOperationError(
        `An unrelated Cloudflare Email Routing rule owns ${recipient} or one of its plus addresses; remove that conflict before reconciliation`,
      );
    }
    let rule = named[0];
    if (row.rule_id && !rule) {
      const existing = await client.getRoutingRule(shared.connection.zone_id, row.rule_id);
      if (existing) {
        throw new EmailOperationError(
          'Recorded shared recipient rule ownership changed; restore it before reconciliation',
        );
      }
      if (!(await renewClaim(db, row, { rule_id: null, create_started_at: null }))) {
        return;
      }
      row = { ...row, rule_id: null, create_started_at: null };
    }
    if (!rule) {
      if (row.create_started_at) {
        await finish(db, row, {
          status: 'unknown',
          reason:
            'A previous recipient-rule creation has an unknown outcome; inspect Cloudflare before retrying or deleting this project',
        });
        return;
      }
      if (
        rules.filter((candidate) =>
          candidate.addresses.some((address) => address.endsWith(`@${shared.route.domain}`)),
        ).length >= 200
      ) {
        throw new EmailOperationError(
          'Shared mail domain reached Cloudflare’s 200 routing-rule limit; remove unused rules or request a higher limit at https://developers.cloudflare.com/email-service/platform/limits/',
        );
      }
      // Persist creation intent before POST. A lost response is recovered only
      // by exact deterministic ownership; absence never authorizes another POST.
      const intent = new Date().toISOString();
      if (!(await renewClaim(db, row, { create_started_at: intent }))) {
        return;
      }
      row = { ...row, create_started_at: intent };
      rule = await client.putLiteralRule(shared.connection.zone_id, null, {
        name: row.rule_name,
        address: recipient,
        workerName: shared.connection.ingress_worker_name,
      });
    } else if (!rule.enabled) {
      if (!(await renewClaim(db, row))) {
        return;
      }
      rule = await client.putLiteralRule(shared.connection.zone_id, rule.id, {
        name: row.rule_name,
        address: recipient,
        workerName: shared.connection.ingress_worker_name,
      });
    }
    if (!isOwnedSharedRecipientRule(rule, row, shared.connection.ingress_worker_name)) {
      throw new EmailOperationError('Cloudflare returned an incomplete shared recipient rule');
    }
    if (!(await renewClaim(db, row, { rule_id: rule.id, create_started_at: null }))) {
      return;
    }
    row = { ...row, rule_id: rule.id };
    const live = await client.getRoutingRule(shared.connection.zone_id, rule.id!);
    if (
      !live?.enabled ||
      !isOwnedSharedRecipientRule(live, row, shared.connection.ingress_worker_name)
    ) {
      throw new EmailOperationError('Cloudflare did not confirm the exact shared recipient rule');
    }
    const after = await client.listRoutingRules(shared.connection.zone_id);
    if (
      after.some((candidate) => candidate.id !== row.rule_id && ruleConflicts(candidate, recipient))
    ) {
      throw new EmailOperationError('A conflicting recipient rule appeared during reconciliation');
    }
    await finish(db, row, { status: 'ready', reason: null, create_started_at: null });
  } catch (error) {
    const rejected =
      error instanceof CloudflareApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408;
    await finish(db, row, {
      status: row.create_started_at && !row.rule_id && !rejected ? 'unknown' : 'blocked',
      reason: failureReason(error),
      ...(rejected ? { create_started_at: null } : {}),
    });
  }
}

export async function getSharedEmailRecipientReadiness(
  db: Db,
  env: Bindings,
  projectId: string,
  verifyProvider = false,
) {
  const shared = await sharedRoute(db, env);
  if (!shared) {
    return null;
  }
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) {
    return null;
  }
  const recipient = `${project.slug}@${shared.route.domain}`;
  const [row] = await db
    .select()
    .from(emailSharedRecipients)
    .where(
      and(
        eq(emailSharedRecipients.installation_id, shared.connection.installation_id),
        eq(emailSharedRecipients.project_id, projectId),
        eq(emailSharedRecipients.recipient, recipient),
      ),
    )
    .limit(1);
  let status =
    project.status !== 'active'
      ? 'disabled'
      : row?.status === 'ready' &&
          row.rule_id &&
          !row.removing &&
          shared.route.inbound_status === 'ready'
        ? 'ready'
        : row?.status === 'ready'
          ? 'pending'
          : (row?.status ?? 'pending');
  let reason =
    row?.reason ?? (shared.route.inbound_status !== 'ready' ? shared.route.inbound_reason : null);
  if (verifyProvider && status === 'ready' && row?.rule_id) {
    try {
      const client = createCfCustomerClient(await credentialFor(env, db, shared.connection));
      const [domainIssue, rule, rules] = await Promise.all([
        inspectEmailInboundRoute(client, shared.connection, shared.route.domain, 'shared'),
        client.getRoutingRule(shared.connection.zone_id, row.rule_id),
        client.listRoutingRules(shared.connection.zone_id),
      ]);
      reason =
        domainIssue ??
        (!rule?.enabled ||
        !isOwnedSharedRecipientRule(rule, row, shared.connection.ingress_worker_name)
          ? 'The exact shared recipient rule is missing or changed'
          : rules.some(
                (candidate) => candidate.id !== row.rule_id && ruleConflicts(candidate, recipient),
              )
            ? 'An unrelated rule conflicts with this shared recipient or its plus addresses'
            : null);
    } catch (error) {
      reason = failureReason(error);
    }
    if (reason) {
      status = 'blocked';
    }
    await db
      .update(emailSharedRecipients)
      .set({ status: status === 'ready' ? 'ready' : 'blocked', reason, observed_at: sql`now()` })
      .where(
        and(
          eq(emailSharedRecipients.id, row.id),
          eq(emailSharedRecipients.status, 'ready'),
          eq(emailSharedRecipients.attempt, row.attempt),
        ),
      );
  }
  return { recipient, status, reason, observedAt: row?.observed_at ?? null };
}

/** Critical cleanup: retain the project's reusable slug until exact deletion readback succeeds. */
export async function removeSharedEmailRecipients(
  db: Db,
  env: Bindings,
  projectId: string,
  exceptRecipient?: string,
): Promise<void> {
  const rows = await db
    .select()
    .from(emailSharedRecipients)
    .where(
      and(
        eq(emailSharedRecipients.project_id, projectId),
        ne(emailSharedRecipients.status, 'removed'),
        exceptRecipient ? ne(emailSharedRecipients.recipient, exceptRecipient) : undefined,
      ),
    );
  for (const initial of rows) {
    const [connectionRow] = await db
      .select()
      .from(emailDomainRoutes)
      .innerJoin(emailZoneConnections, eq(emailZoneConnections.id, emailDomainRoutes.connection_id))
      .where(eq(emailDomainRoutes.id, initial.route_id))
      .limit(1);
    if (
      !connectionRow ||
      connectionRow.email_zone_connections.installation_id !== initial.installation_id
    ) {
      throw new EmailOperationError('Shared recipient cleanup identity is unavailable');
    }
    const connection = connectionRow.email_zone_connections;
    const configured = env as Bindings & {
      EMAIL_SHARED_ACCOUNT_ID?: string;
      EMAIL_SHARED_ZONE_ID?: string;
      EMAIL_SHARED_INGRESS_NAME?: string;
    };
    if (
      connectionRow.email_domain_routes.addressing !== 'shared' ||
      initial.installation_id !== emailInstallationId(env) ||
      connection.managed_by !== 'admin' ||
      connection.account_id !== env.CF_ACCOUNT_ID ||
      connection.account_id !== configured.EMAIL_SHARED_ACCOUNT_ID ||
      connection.zone_id !== configured.EMAIL_SHARED_ZONE_ID ||
      connection.ingress_worker_name !== configured.EMAIL_SHARED_INGRESS_NAME
    ) {
      throw new EmailOperationError(
        'Shared recipient cleanup identity does not match this installation',
      );
    }
    const row = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(emailSharedRecipients)
        .where(eq(emailSharedRecipients.id, initial.id))
        .for('update');
      if (!current || current.status === 'removed') {
        return null;
      }
      if (
        current.status === 'reconciling' &&
        Date.parse(current.lease_started_at ?? '') > Date.now() - LEASE_MS
      ) {
        throw new EmailOperationError(
          'Shared recipient reconciliation is still running; retry project deletion',
        );
      }
      const [claimed] = await tx
        .update(emailSharedRecipients)
        .set({
          removing: true,
          status: 'reconciling',
          attempt: current.attempt + 1,
          lease_started_at: sql`now()`,
          updated_at: sql`now()`,
        })
        .where(eq(emailSharedRecipients.id, current.id))
        .returning();
      return claimed!;
    });
    if (!row) {
      continue;
    }
    try {
      const client = createCfCustomerClient(await credentialFor(env, db, connection));
      const rules = await client.listRoutingRules(connection.zone_id);
      const owned = rules.filter(
        (rule) => rule.name === row.rule_name || (row.rule_id && rule.id === row.rule_id),
      );
      if (
        owned.length > 1 ||
        owned.some((rule) => !isOwnedSharedRecipientRule(rule, row, connection.ingress_worker_name))
      ) {
        throw new EmailOperationError(
          'Shared recipient cleanup ownership changed; restore the recorded rule before deleting this project',
        );
      }
      // Listing can be stale. A retained ID must be absent from an exact GET
      // before its reusable address can be released.
      const rule =
        owned[0] ??
        (row.rule_id ? await client.getRoutingRule(connection.zone_id, row.rule_id) : null);
      if (rule && !isOwnedSharedRecipientRule(rule, row, connection.ingress_worker_name)) {
        throw new EmailOperationError(
          'Shared recipient cleanup ownership changed; restore the recorded rule before deleting this project',
        );
      }
      if (!rule && row.create_started_at && !row.rule_id) {
        throw new EmailOperationError(
          'Shared recipient creation has an unknown outcome; resolve it before deleting this project',
        );
      }
      if (rule) {
        const exact = await client.getRoutingRule(connection.zone_id, rule.id!);
        if (exact && !isOwnedSharedRecipientRule(exact, row, connection.ingress_worker_name)) {
          throw new EmailOperationError('Shared recipient ownership changed before deletion');
        }
        if (exact) {
          if (!(await renewClaim(db, row))) {
            throw new EmailOperationError(
              'Shared recipient cleanup was superseded; retry project deletion',
            );
          }
          await client.deleteRoutingRule(connection.zone_id, exact.id!);
        }
        if (await client.getRoutingRule(connection.zone_id, rule.id!)) {
          throw new EmailOperationError('Cloudflare did not confirm shared recipient deletion');
        }
      }
      if (!(await finish(db, row, { status: 'removed', reason: null, create_started_at: null }))) {
        throw new EmailOperationError(
          'Shared recipient cleanup was superseded; retry project deletion',
        );
      }
    } catch (error) {
      await finish(db, row, { status: 'blocked', reason: failureReason(error) });
      throw error;
    }
  }
}

/** Fair bounded repair includes drifted ready rows; provider writes remain identity-fenced. */
export async function reconcileSharedEmailRecipients(db: Db, env: Bindings, limit = 10) {
  if (!(await sharedRoute(db, env))) {
    return;
  }
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .leftJoin(
      emailSharedRecipients,
      and(
        eq(emailSharedRecipients.project_id, projects.id),
        eq(
          emailSharedRecipients.recipient,
          sql`${projects.slug} || '@' || ${env.EMAIL_SENDER_DOMAIN!.toLowerCase()}`,
        ),
      ),
    )
    .where(eq(projects.status, 'active'))
    .orderBy(sql`${emailSharedRecipients.updated_at} asc nulls first`, asc(projects.id))
    .limit(limit);
  for (const row of rows) {
    await reconcileSharedEmailRecipient(db, env, row.id);
  }
}
