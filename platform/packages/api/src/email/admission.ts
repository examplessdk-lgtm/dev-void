import { and, asc, count, desc, eq, gte, ne, sql } from 'drizzle-orm';
import type { Db, DbOrTx, Tx } from '../db.ts';
import { generateId } from '../id.ts';
import { isReservedEmailSlug } from '../reserved-slugs.ts';
import { emailDestinations, projects, users } from '../schema.ts';
import {
  emailActionRecipients,
  emailActions,
  emailMonthlyUsage,
  emailProjectControls,
  emailReceipts,
  emailUnresolvedAttempts,
} from './admission-schema.ts';
import { emailCredentials, emailDomainRoutes } from './connection-schema.ts';
import { resolveEmailDomain } from './connection-service.ts';
import { getEmailRecipientPolicy } from './settings.ts';

export type EmailActionState =
  | 'rejected'
  | 'reserved'
  | 'attempt_started'
  | 'provider_accepted'
  | 'failed'
  | 'outcome_unknown'
  | 'cancelled';
export type EmailActionKind = 'direct' | 'forward' | 'reply';
export type EmailActionRecipient = {
  recipient: string;
  state: EmailActionState;
  errorCode: string | null;
  providerReference: string | null;
};
export type EmailAdmissionResult = {
  operationId: string;
  replay: boolean;
  recipients: Array<EmailActionRecipient>;
  accountId?: string;
};
export type EmailAdmissionInput = {
  projectId: string;
  kind: EmailActionKind;
  key: string;
  digest: string;
  from: string;
  recipients: Array<string>;
  transport: 'binding' | 'send_raw' | 'native_forward' | 'native_reply';
  receiptId?: string;
  /** Only configured server-side; never accept this from a tenant request. */
  sharedSenderDomain: string;
};

export class EmailAdmissionError extends Error {
  constructor(
    readonly code: 'CONFLICT' | 'INVALID_REQUEST' | 'NOT_FOUND' | 'INVALID_STATE',
    message: string,
  ) {
    super(message);
  }
}

/** Operator recovery is never based on elapsed time alone. This excludes recent calls. */
export const EMAIL_ATTEMPT_RECOVERY_MIN_AGE_MS = 24 * 60 * 60 * 1_000;

export async function resolveEmailUnresolvedAttempt(
  db: Db,
  input: { id: string; ended: boolean; reason: string; now?: Date },
) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.id)) {
    throw new EmailAdmissionError('INVALID_REQUEST', 'invalid email attempt ID');
  }
  if (input.ended !== true || !input.reason.trim() || input.reason.length > 500) {
    throw new EmailAdmissionError(
      'INVALID_REQUEST',
      'confirm that the original execution ended and supply a reason of at most 500 characters',
    );
  }
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    // Finishing a send locks the action before deleting its fence. Match that
    // order so a late provider response and operator resolution cannot race.
    const [initialFence] = await tx
      .select()
      .from(emailUnresolvedAttempts)
      .where(eq(emailUnresolvedAttempts.id, input.id))
      .limit(1);
    if (!initialFence) {
      throw new EmailAdmissionError('NOT_FOUND', 'unresolved email attempt not found');
    }
    const [initialRecipient] = await tx
      .select({ actionId: emailActionRecipients.action_id })
      .from(emailActionRecipients)
      .where(eq(emailActionRecipients.id, input.id))
      .limit(1);
    const [action] = initialRecipient
      ? await tx
          .select({ projectId: emailActions.project_id, senderDomain: emailActions.sender_domain })
          .from(emailActions)
          .where(eq(emailActions.id, initialRecipient.actionId))
          .for('update')
      : [];
    const [fence] = await tx
      .select()
      .from(emailUnresolvedAttempts)
      .where(eq(emailUnresolvedAttempts.id, input.id))
      .for('update');
    if (!fence) {
      throw new EmailAdmissionError('NOT_FOUND', 'unresolved email attempt not found');
    }
    if (new Date(fence.started_at).getTime() > now.getTime() - EMAIL_ATTEMPT_RECOVERY_MIN_AGE_MS) {
      throw new EmailAdmissionError('INVALID_STATE', 'email attempt is too recent to resolve');
    }
    const [recipient] = await tx
      .select()
      .from(emailActionRecipients)
      .where(eq(emailActionRecipients.id, input.id))
      .for('update');
    if (recipient) {
      if (
        recipient.state !== 'attempt_started' ||
        recipient.project_id !== fence.project_id ||
        action?.projectId !== fence.project_id ||
        action?.senderDomain !== fence.sender_domain ||
        new Date(recipient.attempt_started_at ?? now).getTime() >
          now.getTime() - EMAIL_ATTEMPT_RECOVERY_MIN_AGE_MS
      ) {
        throw new EmailAdmissionError('INVALID_STATE', 'email attempt ledger disagrees with fence');
      }
      await tx
        .update(emailActionRecipients)
        .set({
          state: 'outcome_unknown',
          error_code: 'OUTCOME_UNKNOWN',
          completed_at: now.toISOString(),
        })
        .where(eq(emailActionRecipients.id, input.id));
    }
    await tx.delete(emailUnresolvedAttempts).where(eq(emailUnresolvedAttempts.id, input.id));
    return {
      id: fence.id,
      projectId: fence.project_id,
      senderDomain: fence.sender_domain,
      startedAt: fence.started_at,
      state: 'outcome_unknown' as const,
      metadataExpired: !recipient,
      charged: true,
    };
  });
}

/** Policy mutations take this exclusive lock; admission takes it shared. */
export async function lockEmailPolicy(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('email-admission:policy'))`);
}
async function lockEmailPolicyForAdmission(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext('email-admission:policy'))`);
}

export async function withProjectEmailControlLock<T>(
  db: Db,
  projectId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await lockEmailPolicy(tx);
    const [project] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for('update');
    if (!project) {
      throw new EmailAdmissionError('NOT_FOUND', 'project not found');
    }
    return fn(tx);
  });
}

async function ensureControls(tx: Tx, projectId: string) {
  await tx.insert(emailProjectControls).values({ project_id: projectId }).onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(emailProjectControls)
    .where(eq(emailProjectControls.project_id, projectId))
    .for('update');
  return row!;
}

export async function setProjectEmailLimits(
  db: Db,
  projectId: string,
  limits: { monthly?: number | null; burst?: number | null },
) {
  return withProjectEmailControlLock(db, projectId, async (tx) => {
    await ensureControls(tx, projectId);
    const update: {
      monthly_limit?: number;
      burst_limit?: number;
      version: ReturnType<typeof sql>;
    } = { version: sql`${emailProjectControls.version} + 1` };
    if (limits.monthly !== undefined) {
      update.monthly_limit = limits.monthly ?? 200;
    }
    if (limits.burst !== undefined) {
      update.burst_limit = limits.burst ?? 10;
    }
    for (const value of [update.monthly_limit, update.burst_limit]) {
      if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 1_000_000)) {
        throw new EmailAdmissionError('INVALID_REQUEST', 'invalid email limit');
      }
    }
    const [row] = await tx
      .update(emailProjectControls)
      .set(update)
      .where(eq(emailProjectControls.project_id, projectId))
      .returning();
    return row!;
  });
}

export async function setProjectEmailSuspended(db: Db, projectId: string, suspended: boolean) {
  return withProjectEmailControlLock(db, projectId, async (tx) => {
    await ensureControls(tx, projectId);
    const [row] = await tx
      .update(emailProjectControls)
      .set({
        suspended_at: suspended ? new Date().toISOString() : null,
        version: sql`${emailProjectControls.version} + 1`,
      })
      .where(eq(emailProjectControls.project_id, projectId))
      .returning();
    return row!;
  });
}

function monthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

async function currentRecipients(
  tx: DbOrTx,
  actionId: string,
): Promise<Array<EmailActionRecipient>> {
  const rows = await tx
    .select()
    .from(emailActionRecipients)
    .where(eq(emailActionRecipients.action_id, actionId))
    .orderBy(asc(emailActionRecipients.id));
  return rows.map((r) => ({
    recipient: r.recipient,
    state: r.state,
    errorCode: r.error_code,
    providerReference: r.provider_reference,
  }));
}

function validAddress(address: string): boolean {
  return address.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
}

export async function admitEmailAction(
  db: Db,
  input: EmailAdmissionInput,
): Promise<EmailAdmissionResult> {
  if (
    !input.key ||
    input.key.length > (input.kind === 'direct' ? 128 : 256) ||
    !/^[a-f0-9]{64}$/.test(input.digest) ||
    input.recipients.length > (input.kind === 'direct' ? 50 : 100) ||
    !validAddress(input.from)
  ) {
    throw new EmailAdmissionError('INVALID_REQUEST', 'invalid email action');
  }
  if (input.kind !== 'direct' && !input.receiptId) {
    throw new EmailAdmissionError('INVALID_REQUEST', 'inbound action requires a receipt');
  }
  const recipients = [...new Set(input.recipients.map((r) => r.trim().toLowerCase()))];
  if (recipients.length === 0 || recipients.some((r) => !validAddress(r))) {
    throw new EmailAdmissionError('INVALID_REQUEST', 'invalid recipient');
  }
  return db.transaction(async (tx) => {
    await lockEmailPolicyForAdmission(tx);
    const [project] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .for('update');
    if (!project) {
      throw new EmailAdmissionError('NOT_FOUND', 'project not found');
    }
    const [existing] = await tx
      .select()
      .from(emailActions)
      .where(
        and(
          eq(emailActions.project_id, input.projectId),
          eq(emailActions.idempotency_key, input.key),
        ),
      )
      .limit(1);
    if (existing) {
      if (existing.payload_digest !== input.digest || existing.kind !== input.kind) {
        throw new EmailAdmissionError(
          'CONFLICT',
          'idempotency key was used for a different action',
        );
      }
      return {
        operationId: existing.id,
        replay: true,
        recipients: await currentRecipients(tx, existing.id),
      };
    }
    const controls = await ensureControls(tx, input.projectId);
    const [owner] = await tx
      .select({ suspended_reason: users.suspended_reason, email: users.email })
      .from(users)
      .where(eq(users.id, project.user_id))
      .limit(1);
    const policy = await getEmailRecipientPolicy(tx);
    const senderDomain = input.from.toLowerCase().split('@')[1]!;
    const shared = senderDomain === input.sharedSenderDomain.toLowerCase();
    if (shared && !/^[a-z0-9._-]+(?:\+[a-z0-9._=/-]+)?@[a-z0-9.-]+$/i.test(input.from)) {
      throw new EmailAdmissionError('INVALID_REQUEST', 'invalid shared sender');
    }
    const expectedTransport =
      input.kind === 'direct'
        ? shared
          ? 'binding'
          : 'send_raw'
        : shared
          ? input.kind === 'forward'
            ? 'native_forward'
            : 'native_reply'
          : 'send_raw';
    const nativeCustomTransport =
      !shared &&
      input.kind !== 'direct' &&
      input.transport === (input.kind === 'forward' ? 'native_forward' : 'native_reply');
    if (input.transport !== expectedTransport && !nativeCustomTransport) {
      throw new EmailAdmissionError('INVALID_REQUEST', 'invalid email transport');
    }
    let senderAllowed = false;
    let verifiedOnlyTransport = input.transport === 'native_forward';
    if (shared) {
      senderAllowed =
        !isReservedEmailSlug(project.slug) &&
        input.from.toLowerCase().split('@')[0]!.split('+')[0] === project.slug.toLowerCase();
    } else {
      const domain = await resolveEmailDomain(tx, senderDomain);
      senderAllowed =
        domain?.route.project_id === input.projectId &&
        domain.route.desired_state === 'active' &&
        (domain.route.outbound_status === 'ready' ||
          domain.route.outbound_status === 'verified_only') &&
        domain.connection.management_status === 'healthy';
      verifiedOnlyTransport =
        nativeCustomTransport || domain?.route.outbound_status === 'verified_only';
      if (senderAllowed && domain?.connection.credential_id) {
        const [credential] = await tx
          .select({ status: emailCredentials.status })
          .from(emailCredentials)
          .where(eq(emailCredentials.id, domain.connection.credential_id))
          .limit(1);
        senderAllowed = credential?.status === 'healthy';
      } else {
        senderAllowed = false;
      }
    }
    const destinations = await tx
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.project_id, input.projectId));
    const verified = new Set(
      destinations
        .filter(
          (d) =>
            d.status === 'verified' &&
            (!d.verified_by_user_id ||
              (d.verified_by_user_id === project.user_id &&
                d.verified_by_email_snapshot?.toLowerCase() === owner?.email?.toLowerCase())),
        )
        .map((d) => d.address.toLowerCase()),
    );
    const now = new Date();
    const windowStart = new Date(now.getTime() - 60_000).toISOString();
    const [burst] = await tx
      .select({ n: count() })
      .from(emailActionRecipients)
      .where(
        and(
          eq(emailActionRecipients.project_id, input.projectId),
          gte(emailActionRecipients.reserved_at, windowStart),
          ne(emailActionRecipients.state, 'cancelled'),
        ),
      );
    const month = monthStart(now).slice(0, 7);
    await tx
      .insert(emailMonthlyUsage)
      .values({ project_id: input.projectId, month })
      .onConflictDoNothing();
    const [monthly] = await tx
      .select()
      .from(emailMonthlyUsage)
      .where(
        and(eq(emailMonthlyUsage.project_id, input.projectId), eq(emailMonthlyUsage.month, month)),
      )
      .for('update');
    let burstUsed = burst?.n ?? 0;
    let monthUsed = monthly?.recipient_attempts ?? 0;
    if (input.receiptId) {
      const [receipt] = await tx
        .select()
        .from(emailReceipts)
        .where(eq(emailReceipts.id, input.receiptId))
        .limit(1);
      if (
        !receipt ||
        receipt.project_id !== input.projectId ||
        receipt.status !== 'handler_completed'
      ) {
        throw new EmailAdmissionError('INVALID_REQUEST', 'receipt is not ready for actions');
      }
    }
    const actionId = generateId('emailact');
    await tx.insert(emailActions).values({
      id: actionId,
      project_id: input.projectId,
      sender_domain: senderDomain,
      receipt_id: input.receiptId ?? null,
      kind: input.kind,
      idempotency_key: input.key,
      payload_digest: input.digest,
      transport: input.transport,
      policy_version: controls.version,
    });
    let admittedCount = 0;
    for (const recipient of recipients) {
      const domain = recipient.split('@')[1]!;
      const consent = verified.has(recipient);
      const allowedByMode =
        policy.mode === 'any' || (policy.mode === 'domains' && policy.domains.includes(domain));
      const destinationRoute = await resolveEmailDomain(tx, domain);
      const sharedDestination =
        domain === input.sharedSenderDomain.toLowerCase() ||
        destinationRoute?.route.addressing === 'shared';
      const allowed =
        consent || (!sharedDestination && !verifiedOnlyTransport && (!shared || allowedByMode));
      let errorCode: string | null = null;
      if (project.status !== 'active' || owner?.suspended_reason || controls.suspended_at) {
        errorCode = 'SUSPENDED';
      } else if (!senderAllowed) {
        errorCode = 'INVALID_FROM';
      } else if (input.kind === 'forward' && input.transport === 'send_raw') {
        errorCode = 'UNSUPPORTED_ACTION';
      } else if (!allowed) {
        errorCode = 'UNVERIFIED_DESTINATION';
      } else if (burstUsed >= controls.burst_limit || monthUsed >= controls.monthly_limit) {
        errorCode = 'QUOTA_EXCEEDED';
      }
      const admitted = errorCode === null;
      await tx.insert(emailActionRecipients).values({
        id: generateId('emailrcpt'),
        action_id: actionId,
        project_id: input.projectId,
        recipient,
        state: admitted ? 'reserved' : 'rejected',
        error_code: errorCode,
        reserved_at: admitted ? now.toISOString() : null,
      });
      if (admitted) {
        burstUsed++;
        monthUsed++;
        admittedCount++;
      }
    }
    if (admittedCount) {
      await tx
        .update(emailMonthlyUsage)
        .set({
          recipient_attempts: sql`${emailMonthlyUsage.recipient_attempts} + ${admittedCount}`,
        })
        .where(
          and(
            eq(emailMonthlyUsage.project_id, input.projectId),
            eq(emailMonthlyUsage.month, month),
          ),
        );
    }
    return {
      operationId: actionId,
      replay: false,
      recipients: await currentRecipients(tx, actionId),
      ...(!shared && senderAllowed
        ? { accountId: (await resolveEmailDomain(tx, senderDomain))!.connection.account_id }
        : {}),
    };
  });
}

export async function transitionEmailRecipients(
  db: Db,
  actionId: string,
  recipients: Array<string>,
  next: 'attempt_started' | 'provider_accepted' | 'failed' | 'outcome_unknown' | 'cancelled',
  details: { providerReference?: string; errorCode?: string } = {},
) {
  const normalized = [...new Set(recipients.map((r) => r.toLowerCase()))];
  return db.transaction(async (tx) => {
    // Serialize starts with project teardown. Once deleting is visible, an
    // admitted reservation cannot become a provider side effect.
    if (next === 'attempt_started') {
      await lockEmailPolicyForAdmission(tx);
    }
    const [actionIdentity] = await tx
      .select({ projectId: emailActions.project_id })
      .from(emailActions)
      .where(eq(emailActions.id, actionId))
      .limit(1);
    if (!actionIdentity) {
      throw new EmailAdmissionError('NOT_FOUND', 'email action not found');
    }
    if (next === 'attempt_started') {
      const [project] = await tx
        .select({ status: projects.status })
        .from(projects)
        .where(eq(projects.id, actionIdentity.projectId))
        .for('update');
      if (project?.status !== 'active') {
        throw new EmailAdmissionError('INVALID_STATE', 'project is not active');
      }
    }
    const [action] = await tx
      .select()
      .from(emailActions)
      .where(eq(emailActions.id, actionId))
      .for('update');
    if (!action) {
      throw new EmailAdmissionError('NOT_FOUND', 'email action not found');
    }
    if (next === 'attempt_started') {
      const [controls] = await tx
        .select({ suspendedAt: emailProjectControls.suspended_at })
        .from(emailProjectControls)
        .where(eq(emailProjectControls.project_id, action.project_id))
        .for('update');
      if (!controls || controls.suspendedAt) {
        throw new EmailAdmissionError('INVALID_STATE', 'email sending is suspended');
      }
      if (
        action.transport === 'send_raw' ||
        action.transport === 'native_forward' ||
        action.transport === 'native_reply'
      ) {
        const route = await resolveEmailDomain(tx, action.sender_domain);
        if (action.transport === 'send_raw' || route?.route.addressing === 'custom') {
          if (
            !route ||
            route.route.project_id !== action.project_id ||
            route.route.desired_state !== 'active' ||
            !['ready', 'verified_only'].includes(route.route.outbound_status) ||
            route.connection.management_status !== 'healthy'
          ) {
            throw new EmailAdmissionError('INVALID_STATE', 'email route is not active');
          }
        }
      }
    }
    const rows = await tx
      .select()
      .from(emailActionRecipients)
      .where(eq(emailActionRecipients.action_id, actionId));
    if (normalized.some((r) => !rows.some((row) => row.recipient === r))) {
      throw new EmailAdmissionError('INVALID_REQUEST', 'recipient is not in action');
    }
    for (const recipient of normalized) {
      const current = rows.find((row) => row.recipient === recipient)!;
      const expected =
        next === 'attempt_started' || next === 'cancelled' ? 'reserved' : 'attempt_started';
      if (current.state !== expected) {
        throw new EmailAdmissionError('INVALID_STATE', `recipient is ${current.state}`);
      }
      await tx
        .update(emailActionRecipients)
        .set({
          state: next,
          ...(next === 'attempt_started'
            ? { attempt_started_at: new Date().toISOString() }
            : { completed_at: new Date().toISOString() }),
          ...(details.providerReference ? { provider_reference: details.providerReference } : {}),
          ...(details.errorCode ? { error_code: details.errorCode } : {}),
        })
        .where(eq(emailActionRecipients.id, current.id));
      if (next === 'attempt_started') {
        await tx.insert(emailUnresolvedAttempts).values({
          id: current.id,
          project_id: action.project_id,
          sender_domain: action.sender_domain,
          started_at: new Date().toISOString(),
        });
      } else if (next !== 'cancelled') {
        await tx.delete(emailUnresolvedAttempts).where(eq(emailUnresolvedAttempts.id, current.id));
      }
      if (next === 'cancelled' && current.reserved_at) {
        await tx
          .update(emailMonthlyUsage)
          .set({
            recipient_attempts: sql`greatest(0, ${emailMonthlyUsage.recipient_attempts} - 1)`,
          })
          .where(
            and(
              eq(emailMonthlyUsage.project_id, action.project_id),
              eq(emailMonthlyUsage.month, current.reserved_at.slice(0, 7)),
            ),
          );
      }
    }
    return currentRecipients(tx, actionId);
  });
}

/** Fence all new starts and release only reservations that never reached a provider. */
export async function drainProjectEmailAdmissions(
  db: Db,
  projectId: string,
): Promise<{ cancelled: number; inFlight: number }> {
  return db.transaction(async (tx) => {
    await lockEmailPolicy(tx);
    const [project] = await tx
      .select({ status: projects.status })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for('update');
    if (!project || project.status !== 'deleting') {
      throw new EmailAdmissionError('INVALID_STATE', 'project must be deleting before email drain');
    }
    const [controls] = await tx
      .select({ id: emailProjectControls.project_id })
      .from(emailProjectControls)
      .where(eq(emailProjectControls.project_id, projectId))
      .for('update');
    if (!controls) {
      // A project with no email control row has never admitted an action.
      return { cancelled: 0, inFlight: 0 };
    }
    const cancelled = await tx
      .update(emailActionRecipients)
      .set({ state: 'cancelled', completed_at: new Date().toISOString() })
      .where(
        and(
          eq(emailActionRecipients.project_id, projectId),
          eq(emailActionRecipients.state, 'reserved'),
        ),
      )
      .returning({ reservedAt: emailActionRecipients.reserved_at });
    const monthlyRefunds = new Map<string, number>();
    for (const row of cancelled) {
      if (row.reservedAt) {
        const month = row.reservedAt.slice(0, 7);
        monthlyRefunds.set(month, (monthlyRefunds.get(month) ?? 0) + 1);
      }
    }
    for (const [month, amount] of monthlyRefunds) {
      await tx
        .update(emailMonthlyUsage)
        .set({
          recipient_attempts: sql`greatest(0, ${emailMonthlyUsage.recipient_attempts} - ${amount})`,
        })
        .where(
          and(eq(emailMonthlyUsage.project_id, projectId), eq(emailMonthlyUsage.month, month)),
        );
    }
    const [unresolved] = await tx
      .select({ n: count() })
      .from(emailUnresolvedAttempts)
      .where(eq(emailUnresolvedAttempts.project_id, projectId));
    return { cancelled: cancelled.length, inFlight: unresolved?.n ?? 0 };
  });
}

/** Disable a custom route and drain its unstarted sends under the admission fence. */
export async function disableEmailDomainRouteAndDrain(
  db: Db,
  routeId: string,
): Promise<{ cancelled: number; inFlight: number }> {
  return db.transaction((tx) => disableEmailDomainRouteAndDrainTx(tx, routeId));
}

export async function disableEmailDomainRouteAndDrainTx(
  tx: Tx,
  routeId: string,
): Promise<{ cancelled: number; inFlight: number }> {
  await lockEmailPolicy(tx);
  const [route] = await tx
    .select()
    .from(emailDomainRoutes)
    .where(eq(emailDomainRoutes.id, routeId))
    .for('update');
  if (!route || route.addressing !== 'custom' || !route.project_id) {
    throw new EmailAdmissionError('NOT_FOUND', 'custom email route not found');
  }
  if (route.desired_state === 'removed') {
    return { cancelled: 0, inFlight: 0 };
  }
  await tx
    .update(emailDomainRoutes)
    .set({
      desired_state: 'disabled',
      inbound_status: 'disabled',
      desired_generation: sql`${emailDomainRoutes.desired_generation} + 1`,
      updated_at: sql`now()`,
    })
    .where(eq(emailDomainRoutes.id, routeId));
  const cancelled = await tx
    .update(emailActionRecipients)
    .set({
      state: 'cancelled',
      completed_at: new Date().toISOString(),
    })
    .where(sql`
      ${emailActionRecipients.state} = 'reserved'
      and ${emailActionRecipients.action_id} in (
        select ${emailActions.id} from ${emailActions}
        where ${emailActions.project_id} = ${route.project_id}
          and ${emailActions.sender_domain} = ${route.domain}
      )
    `)
    .returning({ reservedAt: emailActionRecipients.reserved_at });
  const monthlyRefunds = new Map<string, number>();
  for (const row of cancelled) {
    if (row.reservedAt) {
      const month = row.reservedAt.slice(0, 7);
      monthlyRefunds.set(month, (monthlyRefunds.get(month) ?? 0) + 1);
    }
  }
  for (const [month, amount] of monthlyRefunds) {
    await tx
      .update(emailMonthlyUsage)
      .set({
        recipient_attempts: sql`greatest(0, ${emailMonthlyUsage.recipient_attempts} - ${amount})`,
      })
      .where(
        and(eq(emailMonthlyUsage.project_id, route.project_id), eq(emailMonthlyUsage.month, month)),
      );
  }
  const [unresolved] = await tx
    .select({ n: count() })
    .from(emailUnresolvedAttempts)
    .where(
      and(
        eq(emailUnresolvedAttempts.project_id, route.project_id),
        eq(emailUnresolvedAttempts.sender_domain, route.domain),
      ),
    );
  return { cancelled: cancelled.length, inFlight: unresolved?.n ?? 0 };
}

export async function countEmailDomainInFlight(db: Db, routeId: string): Promise<number> {
  const [route] = await db
    .select({ projectId: emailDomainRoutes.project_id, domain: emailDomainRoutes.domain })
    .from(emailDomainRoutes)
    .where(eq(emailDomainRoutes.id, routeId))
    .limit(1);
  if (!route?.projectId) {
    return 0;
  }
  const [row] = await db
    .select({ n: count() })
    .from(emailUnresolvedAttempts)
    .where(
      and(
        eq(emailUnresolvedAttempts.project_id, route.projectId),
        eq(emailUnresolvedAttempts.sender_domain, route.domain),
      ),
    );
  return row?.n ?? 0;
}

export async function getEmailAction(
  db: Db,
  actionId: string,
): Promise<EmailAdmissionResult | null> {
  const [action] = await db
    .select()
    .from(emailActions)
    .where(eq(emailActions.id, actionId))
    .limit(1);
  if (!action) {
    return null;
  }
  return { operationId: actionId, replay: true, recipients: await currentRecipients(db, actionId) };
}

export async function recordEmailReceipt(
  db: Db,
  input: { receiptId: string; projectId: string; status: string },
): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.receiptId) || !/^[a-z_]{1,32}$/.test(input.status)) {
    throw new EmailAdmissionError('INVALID_REQUEST', 'invalid receipt');
  }
  await db.transaction(async (tx) => {
    const [project] = await tx
      .select({ id: projects.id, status: projects.status })
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .for('update');
    if (!project) {
      throw new EmailAdmissionError('NOT_FOUND', 'project not found');
    }
    const [existing] = await tx
      .select()
      .from(emailReceipts)
      .where(eq(emailReceipts.id, input.receiptId))
      .for('update');
    if (existing && existing.project_id !== input.projectId) {
      throw new EmailAdmissionError('CONFLICT', 'receipt belongs to another project');
    }
    if (!existing && project.status !== 'active') {
      throw new EmailAdmissionError('INVALID_STATE', 'project is not active');
    }
    if (existing) {
      await tx
        .update(emailReceipts)
        .set({ status: input.status })
        .where(eq(emailReceipts.id, input.receiptId));
    } else {
      await tx
        .insert(emailReceipts)
        .values({ id: input.receiptId, project_id: input.projectId, status: input.status });
    }
  });
}

export async function claimRelayedEmailReceipt(
  db: Db,
  input: { receiptId: string; projectId: string; payloadDigest: string },
): Promise<{ state: 'claimed' | 'in_progress' | 'completed'; reject?: boolean }> {
  if (!/^[a-f0-9]{64}$/.test(input.receiptId) || !/^[a-f0-9]{64}$/.test(input.payloadDigest)) {
    throw new EmailAdmissionError('INVALID_REQUEST', 'invalid relay claim');
  }
  return db.transaction(async (tx) => {
    const [project] = await tx
      .select({ status: projects.status })
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .for('update');
    if (!project || project.status !== 'active') {
      throw new EmailAdmissionError('INVALID_STATE', 'project is not active');
    }
    const inserted = await tx
      .insert(emailReceipts)
      .values({
        id: input.receiptId,
        project_id: input.projectId,
        payload_digest: input.payloadDigest,
        status: 'received',
      })
      .onConflictDoNothing()
      .returning({ id: emailReceipts.id });
    if (inserted.length) {
      return { state: 'claimed' };
    }
    const [existing] = await tx
      .select()
      .from(emailReceipts)
      .where(eq(emailReceipts.id, input.receiptId))
      .for('update');
    if (
      !existing ||
      existing.project_id !== input.projectId ||
      existing.payload_digest !== input.payloadDigest
    ) {
      throw new EmailAdmissionError('CONFLICT', 'relay invocation content conflict');
    }
    return (existing.status === 'delivery_completed' || existing.status === 'actions_rejected') &&
      existing.final_reject !== null
      ? { state: 'completed', reject: existing.final_reject }
      : { state: 'in_progress' };
  });
}

export async function completeRelayedEmailReceipt(
  db: Db,
  input: { receiptId: string; projectId: string; payloadDigest: string; reject: boolean },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(emailReceipts)
      .where(eq(emailReceipts.id, input.receiptId))
      .for('update');
    if (
      !existing ||
      existing.project_id !== input.projectId ||
      existing.payload_digest !== input.payloadDigest
    ) {
      throw new EmailAdmissionError('CONFLICT', 'relay receipt mismatch');
    }
    if (existing.final_reject !== null) {
      if (existing.final_reject !== input.reject) {
        throw new EmailAdmissionError('CONFLICT', 'relay outcome conflict');
      }
      return;
    }
    if (existing.status !== 'handler_completed' && existing.status !== 'actions_rejected') {
      throw new EmailAdmissionError('INVALID_STATE', 'relay handler has not completed');
    }
    await tx
      .update(emailReceipts)
      .set({
        status: existing.status === 'actions_rejected' ? 'actions_rejected' : 'delivery_completed',
        final_reject: input.reject,
      })
      .where(eq(emailReceipts.id, input.receiptId));
  });
}

export async function getProjectEmailUsage(db: Db, projectId: string) {
  const now = new Date();
  const [controls] = await db
    .select()
    .from(emailProjectControls)
    .where(eq(emailProjectControls.project_id, projectId))
    .limit(1);
  const [monthly] = await db
    .select()
    .from(emailMonthlyUsage)
    .where(
      and(
        eq(emailMonthlyUsage.project_id, projectId),
        eq(emailMonthlyUsage.month, monthStart(now).slice(0, 7)),
      ),
    );
  const [received] = await db
    .select({ n: count() })
    .from(emailReceipts)
    .where(
      and(eq(emailReceipts.project_id, projectId), gte(emailReceipts.created_at, monthStart(now))),
    );
  const limit = controls?.monthly_limit ?? 200;
  const sent = monthly?.recipient_attempts ?? 0;
  return {
    month: monthStart(now).slice(0, 7),
    sent,
    received: received?.n ?? 0,
    limit,
    remaining: Math.max(0, limit - sent),
    suspended: !!controls?.suspended_at,
  };
}

export async function getProjectEmailLogs(db: Db, projectId: string, limit = 50) {
  const cap = Math.max(1, Math.min(limit, 100));
  const rows = await db
    .select({ action: emailActions, recipient: emailActionRecipients })
    .from(emailActionRecipients)
    .innerJoin(emailActions, eq(emailActions.id, emailActionRecipients.action_id))
    .where(eq(emailActions.project_id, projectId))
    .orderBy(desc(emailActions.created_at))
    .limit(cap);
  const receipts = await db
    .select()
    .from(emailReceipts)
    .where(eq(emailReceipts.project_id, projectId))
    .orderBy(desc(emailReceipts.created_at))
    .limit(cap);
  return {
    logs: [
      ...rows.map(({ action, recipient }) => ({
        timestamp: Date.parse(action.created_at),
        direction: 'sent' as const,
        operationId: action.id,
        receiptId: action.receipt_id,
        recipient: recipient.recipient,
        status: recipient.state,
        transport: action.transport,
        providerReference: recipient.provider_reference,
        errorCode: recipient.error_code,
        policyVersion: action.policy_version,
      })),
      ...receipts.map((receipt) => ({
        timestamp: Date.parse(receipt.created_at),
        direction: 'received' as const,
        operationId: receipt.id,
        receiptId: receipt.id,
        recipient: null,
        status: receipt.status,
        transport: 'email_event',
        providerReference: null,
        errorCode: receipt.status === 'actions_rejected' ? 'INVALID_ACTIONS' : null,
        policyVersion: null,
      })),
    ]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, cap),
  };
}

export async function pruneEmailActionHistory(
  db: Db,
  before: Date = new Date(Date.now() - 30 * 86_400_000),
) {
  // Active calls leave PII-free tombstones; delivery metadata expires normally.
  await db.delete(emailActions).where(sql`
    ${emailActions.created_at} < ${before.toISOString()}
  `);
  await db.delete(emailReceipts).where(sql`${emailReceipts.created_at} < ${before.toISOString()}`);
  await db.delete(emailMonthlyUsage).where(sql`
    ${emailMonthlyUsage.month} < ${new Date().toISOString().slice(0, 7)}
  `);
}
