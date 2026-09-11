import { Hono } from 'hono';
import {
  createInvitation,
  revokeInvitation,
  getInvitation,
  getPendingInvitationByEmail,
  getAllInvitations,
  countInvitations,
  getUserByEmail,
} from '../../db.ts';
import { sendInvitationEmail } from '../../email.ts';
import type { ApiEnv } from '../../env.ts';
import { getAllowlist, putAllowlist } from '../../signup-allowlist.ts';
import { InvitationsPage } from '../views/invitations.tsx';

const PAGE_SIZE = 50;

const app = new Hono<ApiEnv>();

function parseInvitationEmails(input: string): ReadonlyArray<string> {
  return Array.from(
    new Set(
      input
        .split(/[\s,]+/)
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

// GET /invitations
app.get('/', async (context) => {
  const db = context.get('db');
  const page = Math.max(1, parseInt(context.req.query('page') ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const [rows, total] = await Promise.all([
    getAllInvitations(db, PAGE_SIZE, offset),
    countInvitations(db),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return context.html(
    <InvitationsPage
      invitations={rows}
      page={page}
      totalPages={totalPages}
      username={context.get('user').login}
    />,
  );
});

// POST /invitations/send
app.post('/send', async (context) => {
  const db = context.get('db');
  const body = await context.req.parseBody();
  const emails = parseInvitationEmails((body.email as string) ?? '');

  if (emails.length === 0 || emails.some((email) => !email.includes('@'))) {
    return context.html('<h1>Invalid email address list</h1>', 400);
  }

  const [existingUsers, existingInvitations, entries] = await Promise.all([
    Promise.all(emails.map((email) => getUserByEmail(db, email))),
    Promise.all(emails.map((email) => getPendingInvitationByEmail(db, email))),
    getAllowlist(context.env.ROUTING),
  ]);

  if (existingUsers.some(Boolean)) {
    return context.html('<h1>A user with one of these emails already exists</h1>', 400);
  }

  if (existingInvitations.some(Boolean)) {
    return context.html(
      '<h1>A pending invitation already exists for one of these emails</h1>',
      400,
    );
  }

  const allowlistedEmails = new Set(
    entries.filter((e) => e.type === 'email').map((e) => e.pattern.toLowerCase()),
  );
  if (emails.some((email) => allowlistedEmails.has(email))) {
    return context.html('<h1>One of these emails is already on the signup allowlist</h1>', 400);
  }

  const userId = context.get('user').id;
  const login = context.get('user').login;

  await Promise.all(emails.map((email) => createInvitation(db, email, userId)));

  for (const email of emails) {
    entries.push({ type: 'email', pattern: email, note: `Invited by ${login}` });
  }
  try {
    await putAllowlist(context.env.ROUTING, entries);
  } catch (err) {
    console.error(`Failed to update signup allowlist after inviting ${emails.join(', ')}:`, err);
    return context.html('<h1>Invitations created but failed to update signup allowlist</h1>', 500);
  }

  // Send emails (non-fatal — invitations + allowlist are already committed)
  if (context.env.EMAIL) {
    for (const email of emails) {
      try {
        await sendInvitationEmail(context.env.EMAIL, email);
      } catch (err) {
        console.error(`Failed to send invitation email to ${email}:`, err);
      }
    }
  }

  return context.redirect('/admin/invitations');
});

// POST /invitations/revoke
app.post('/revoke', async (context) => {
  const db = context.get('db');
  const body = await context.req.parseBody();
  const id = body.id as string;

  if (!id) {
    return context.html('<h1>Missing invitation ID</h1>', 400);
  }

  const invitation = await getInvitation(db, id);
  if (!invitation || invitation.status !== 'pending') {
    return context.html('<h1>Invitation not found or not pending</h1>', 400);
  }

  // Remove from allowlist first so the invitee cannot sign up even if the DB
  // update below fails (admin can retry; the reverse leaves a stale entry).
  const entries = await getAllowlist(context.env.ROUTING);
  const filtered = entries.filter(
    (e) => !(e.type === 'email' && e.pattern.toLowerCase() === invitation.email),
  );
  if (filtered.length !== entries.length) {
    await putAllowlist(context.env.ROUTING, filtered);
  }

  await revokeInvitation(db, id, context.get('user').id);

  return context.redirect('/admin/invitations');
});

export default app;
