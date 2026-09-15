import type { Context } from 'hono';
import {
  type Db,
  countInvitations,
  createInvitation,
  getAllInvitations,
  getAllowlistEntryStatuses,
  getInvitation,
  getPendingInvitationByEmail,
  getUserByEmail,
  revokeInvitation,
} from '../db.ts';
import { sendInvitationEmail } from '../email.ts';
import type { ApiEnv } from '../env.ts';
import { type AllowlistEntry, getAllowlist, putAllowlist } from '../signup-allowlist.ts';
import type { Invitation } from '../types.ts';
import { OperatorError, preview } from './common.ts';

export function parseAccessList(input: string): Array<string> {
  return [
    ...new Set(
      input
        .split(/[\s,]+/)
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

function validateEntryType(type: string): asserts type is AllowlistEntry['type'] {
  if (type !== 'github' && type !== 'email') {
    throw new OperatorError(400, 'Invalid entry type; expected github or email.');
  }
}

export async function getOperatorSignup(context: Context<ApiEnv>) {
  const [raw, entries] = await Promise.all([
    context.env.ROUTING.get('signup:enabled'),
    getAllowlist(context.env.ROUTING),
  ]);
  return {
    enabled: raw === 'true',
    restricted: raw === 'true',
    signupsOpen: raw !== 'true',
    entries: await getAllowlistEntryStatuses(context.get('db'), entries),
  };
}

export async function setOperatorSignup(
  context: Context<ApiEnv>,
  enabled: boolean,
  dryRun = false,
) {
  const previous = (await context.env.ROUTING.get('signup:enabled')) === 'true';
  const action = enabled ? 'signup.restrict' : 'signup.open';
  const target = { restrictionsEnabled: enabled };
  if (dryRun) {
    return preview(action, target, {
      previousRestrictionsEnabled: previous,
      effect: enabled ? 'Only allowlisted users may sign up.' : 'All users may sign up.',
    });
  }
  await context.env.ROUTING.put('signup:enabled', String(enabled));
  return { action, target, enabled, restricted: enabled, signupsOpen: !enabled };
}

export async function allowOperatorSignup(
  context: Context<ApiEnv>,
  type: string,
  patterns: ReadonlyArray<string>,
  note?: string,
  dryRun = false,
) {
  validateEntryType(type);
  if (
    patterns.length === 0 ||
    patterns.length > 100 ||
    patterns.some((pattern) => !pattern || pattern.length > 320 || /[\s,]/.test(pattern))
  ) {
    throw new OperatorError(400, 'Invalid entry; supply between 1 and 100 nonempty patterns.');
  }
  if (note && note.length > 1000) {
    throw new OperatorError(400, 'Note must be at most 1000 characters.');
  }
  const normalized = [...new Set(patterns.map((pattern) => pattern.toLowerCase()))];
  const entries = await getAllowlist(context.env.ROUTING);
  const additions = normalized
    .filter(
      (pattern) =>
        !entries.some((entry) => entry.type === type && entry.pattern.toLowerCase() === pattern),
    )
    .map((pattern): AllowlistEntry => ({ type, pattern, note: note?.trim() || undefined }));
  const target = { type, patterns: normalized };
  if (dryRun) {
    return preview('signup.allow', target, { additions });
  }
  if (additions.length) {
    await putAllowlist(context.env.ROUTING, [...entries, ...additions]);
  }
  return {
    action: 'signup.allow',
    target,
    added: additions,
    unchanged: normalized.length - additions.length,
  };
}

export async function removeOperatorSignup(
  context: Context<ApiEnv>,
  type: string,
  pattern: string,
  dryRun = false,
) {
  validateEntryType(type);
  const normalized = pattern.trim().toLowerCase();
  if (!normalized || normalized.length > 320) {
    throw new OperatorError(400, 'Invalid entry pattern.');
  }
  const entries = await getAllowlist(context.env.ROUTING);
  const removed = entries.filter(
    (entry) => entry.type === type && entry.pattern.toLowerCase() === normalized,
  );
  if (!removed.length) {
    throw new OperatorError(404, 'Signup allowlist entry not found.');
  }
  const target = { type, pattern: normalized };
  if (dryRun) {
    return preview('signup.remove', target, { removed });
  }
  await putAllowlist(
    context.env.ROUTING,
    entries.filter((entry) => !(entry.type === type && entry.pattern.toLowerCase() === normalized)),
  );
  return { action: 'signup.remove', target, removed };
}

export async function listOperatorInvitations(
  db: Db,
  page: { page: number; limit: number; offset: number },
) {
  const [invitations, total] = await Promise.all([
    getAllInvitations(db, page.limit, page.offset),
    countInvitations(db),
  ]);
  return {
    invitations,
    page: page.page,
    limit: page.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / page.limit)),
  };
}

export async function sendOperatorInvitations(
  context: Context<ApiEnv>,
  input: ReadonlyArray<string>,
  dryRun = false,
) {
  if (
    !input.length ||
    input.length > 100 ||
    input.some(
      (email) =>
        typeof email !== 'string' ||
        email.length > 320 ||
        !/^[^\s@,]+@[^\s@,]+$/.test(email.trim()),
    )
  ) {
    throw new OperatorError(
      400,
      'Invalid email address list; supply between 1 and 100 email addresses.',
    );
  }
  const emails = [...new Set(input.map((email) => email.trim().toLowerCase()))];
  const db = context.get('db');
  const [existingUsers, existingInvitations, entries] = await Promise.all([
    Promise.all(emails.map((email) => getUserByEmail(db, email))),
    Promise.all(emails.map((email) => getPendingInvitationByEmail(db, email))),
    getAllowlist(context.env.ROUTING),
  ]);
  if (existingUsers.some(Boolean)) {
    throw new OperatorError(400, 'A user with one of these emails already exists.');
  }
  if (existingInvitations.some(Boolean)) {
    throw new OperatorError(400, 'A pending invitation already exists for one of these emails.');
  }
  const allowlistedEmails = new Set(
    entries.filter((entry) => entry.type === 'email').map((entry) => entry.pattern.toLowerCase()),
  );
  if (emails.some((email) => allowlistedEmails.has(email))) {
    throw new OperatorError(400, 'One of these emails is already on the signup allowlist.');
  }
  const target = { emails };
  if (dryRun) {
    return preview('invitation.send', target, {
      emailDelivery: context.env.EMAIL ? 'enabled' : 'unavailable',
      addsSignupAccess: true,
    });
  }

  // Capture each committed result. A DB or KV failure must never hide which
  // invitations exist already, and an ambiguous failure must not be retried.
  const created: Array<Invitation> = [];
  try {
    for (const email of emails) {
      created.push(await createInvitation(db, email, context.get('user').id));
    }
    await putAllowlist(context.env.ROUTING, [
      ...entries,
      ...emails.map((email): AllowlistEntry => ({
        type: 'email',
        pattern: email,
        note: `Invited by ${context.get('user').login}`,
      })),
    ]);
  } catch (error) {
    console.error('[admin] invitation creation failed', { emails, error });
    throw new OperatorError(
      500,
      'Invitation creation incomplete. Inspect invitations and the signup allowlist before retrying.',
      'partial_failure',
      {
        partial: true,
        target,
        invitations: created,
        emailDelivery: 'not_attempted',
        allowlistConfirmed: false,
      },
    );
  }
  const emailDelivery: Array<{ email: string; status: 'sent' | 'failed' | 'unavailable' }> = [];
  for (const email of emails) {
    if (!context.env.EMAIL) {
      emailDelivery.push({ email, status: 'unavailable' });
      continue;
    }
    try {
      await sendInvitationEmail(context.env, email);
      emailDelivery.push({ email, status: 'sent' });
    } catch (error) {
      console.error('[admin] invitation email failed', { email, error });
      emailDelivery.push({ email, status: 'failed' });
    }
  }
  return {
    action: 'invitation.send',
    target,
    invitations: created,
    emailDelivery,
    warnings: emailDelivery
      .filter((entry) => entry.status !== 'sent')
      .map((entry) => `Email ${entry.status}: ${entry.email}. Signup access was granted.`),
  };
}

export async function revokeOperatorInvitation(
  context: Context<ApiEnv>,
  id: string,
  dryRun = false,
) {
  const db = context.get('db');
  const invitation = await getInvitation(db, id);
  if (!invitation) {
    throw new OperatorError(404, 'Invitation not found.');
  }
  if (invitation.status !== 'pending') {
    throw new OperatorError(409, 'Invitation is not pending.');
  }
  const entries = await getAllowlist(context.env.ROUTING);
  const filtered = entries.filter(
    (entry) =>
      !(entry.type === 'email' && entry.pattern.toLowerCase() === invitation.email.toLowerCase()),
  );
  const target = { id, email: invitation.email };
  if (dryRun) {
    return preview('invitation.revoke', target, {
      removesSignupEntries: entries.length - filtered.length,
    });
  }
  // Remove access before updating the invitation row, keeping a failed revoke
  // retryable without leaving a stale exact-email allowlist grant.
  let allowlistUpdated = false;
  try {
    if (filtered.length !== entries.length) {
      await putAllowlist(context.env.ROUTING, filtered);
    }
    allowlistUpdated = true;
    if (!(await revokeInvitation(db, id, context.get('user').id))) {
      throw new OperatorError(
        409,
        'Invitation changed while revoking; inspect its current status.',
        'conflict',
        { partial: true, target, allowlistUpdated },
      );
    }
  } catch (error) {
    if (error instanceof OperatorError) {
      throw error;
    }
    console.error('[admin] invitation revocation failed', { id, error });
    throw new OperatorError(
      500,
      'Invitation revocation incomplete. Inspect its status and the signup allowlist before retrying.',
      'partial_failure',
      { partial: true, target, allowlistUpdated },
    );
  }
  return { action: 'invitation.revoke', target, revoked: true };
}
