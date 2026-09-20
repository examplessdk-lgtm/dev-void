import { and, desc, eq, isNull } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { PROJECT_CREDENTIAL_MAX_DAYS, signProjectCredentialToken } from '../auth/deploy-token.ts';
import { getProject, type DbOrTx } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { projectDeployCredentials, projects } from '../schema.ts';

const app = new Hono<ApiEnv>();

function parseExpiryDays(value: unknown): number {
  const days = value === undefined ? 30 : value;
  if (!Number.isInteger(days) || Number(days) < 1 || Number(days) > PROJECT_CREDENTIAL_MAX_DAYS) {
    throw new Error(`expiresInDays must be an integer from 1 to ${PROJECT_CREDENTIAL_MAX_DAYS}`);
  }
  return Number(days);
}

function parseName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : 'CI deploy';
  // eslint-disable-next-line no-control-regex -- Names are shown in terminals and must exclude control characters.
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error('name must contain 1 to 80 printable characters');
  }
  return name;
}

async function ownedProject(context: Context<ApiEnv>) {
  const projectId = context.req.param('projectId');
  if (!projectId) {
    return null;
  }
  const project = await getProject(context.get('db'), projectId);
  if (!project || project.user_id !== context.get('user').id) {
    return null;
  }
  return project;
}

async function lockOwnedProject(db: DbOrTx, projectId: string, userId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .for('update')
    .limit(1);
  return project?.user_id === userId ? project : null;
}

function publicCredential(row: typeof projectDeployCredentials.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

app.get('/:projectId/tokens', async (context) => {
  const project = await ownedProject(context);
  if (!project) {
    return context.json({ error: 'project not found' }, 404);
  }
  const rows = await context
    .get('db')
    .select()
    .from(projectDeployCredentials)
    .where(eq(projectDeployCredentials.project_id, project.id))
    .orderBy(desc(projectDeployCredentials.created_at))
    .limit(100);
  return context.json(rows.map(publicCredential));
});

app.post('/:projectId/tokens', async (context) => {
  const projectId = context.req.param('projectId');
  if (!projectId) {
    return context.json({ error: 'project not found' }, 404);
  }
  const body = await context.req
    .json<{ name?: unknown; expiresInDays?: unknown }>()
    .catch(() => ({}) as { name?: unknown; expiresInDays?: unknown });
  let name: string;
  let days: number;
  try {
    name = parseName(body.name);
    days = parseExpiryDays(body.expiresInDays);
  } catch (error) {
    return context.json({ error: error instanceof Error ? error.message : 'invalid request' }, 400);
  }
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const user = context.get('user');
  const token = await signProjectCredentialToken(
    { credentialId: id, projectId, userId: user.id, login: user.login, expiresAt },
    context.env.JWT_SECRET,
  );
  const row = await context.get('db').transaction(async (tx) => {
    const project = await lockOwnedProject(tx, projectId, user.id);
    if (!project) {
      return null;
    }
    const [created] = await tx
      .insert(projectDeployCredentials)
      .values({
        id,
        project_id: project.id,
        issued_by: user.id,
        name,
        expires_at: expiresAt.toISOString(),
      })
      .returning();
    return created!;
  });
  if (!row) {
    return context.json({ error: 'project not found' }, 404);
  }
  return context.json({ ...publicCredential(row), token }, 201);
});

app.post('/:projectId/tokens/:credentialId/renew', async (context) => {
  const projectId = context.req.param('projectId');
  if (!projectId) {
    return context.json({ error: 'project not found' }, 404);
  }
  const body = await context.req
    .json<{ expiresInDays?: unknown }>()
    .catch(() => ({}) as { expiresInDays?: unknown });
  let days: number;
  try {
    days = parseExpiryDays(body.expiresInDays);
  } catch (error) {
    return context.json({ error: error instanceof Error ? error.message : 'invalid request' }, 400);
  }
  const user = context.get('user');
  const replacementId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const token = await signProjectCredentialToken(
    {
      credentialId: replacementId,
      projectId,
      userId: user.id,
      login: user.login,
      expiresAt,
    },
    context.env.JWT_SECRET,
  );
  const result = await context.get('db').transaction(async (transaction) => {
    const project = await lockOwnedProject(transaction, projectId, user.id);
    if (!project) {
      return 'project-not-found' as const;
    }
    const [current] = await transaction
      .select()
      .from(projectDeployCredentials)
      .where(
        and(
          eq(projectDeployCredentials.id, context.req.param('credentialId')),
          eq(projectDeployCredentials.project_id, project.id),
          isNull(projectDeployCredentials.revoked_at),
        ),
      )
      .for('update');
    if (!current) {
      return null;
    }
    await transaction
      .update(projectDeployCredentials)
      .set({ revoked_at: new Date().toISOString() })
      .where(eq(projectDeployCredentials.id, current.id));
    const [replacement] = await transaction
      .insert(projectDeployCredentials)
      .values({
        id: replacementId,
        project_id: project.id,
        issued_by: user.id,
        name: current.name,
        expires_at: expiresAt.toISOString(),
      })
      .returning();
    return replacement!;
  });
  if (result === 'project-not-found') {
    return context.json({ error: 'project not found' }, 404);
  }
  if (!result) {
    return context.json({ error: 'active credential not found' }, 404);
  }
  return context.json({ ...publicCredential(result), token });
});

app.delete('/:projectId/tokens/:credentialId', async (context) => {
  const projectId = context.req.param('projectId');
  if (!projectId) {
    return context.json({ error: 'project not found' }, 404);
  }
  const user = context.get('user');
  const row = await context.get('db').transaction(async (tx) => {
    const project = await lockOwnedProject(tx, projectId, user.id);
    if (!project) {
      return 'project-not-found' as const;
    }
    const [revoked] = await tx
      .update(projectDeployCredentials)
      .set({ revoked_at: new Date().toISOString() })
      .where(
        and(
          eq(projectDeployCredentials.id, context.req.param('credentialId')),
          eq(projectDeployCredentials.project_id, project.id),
          isNull(projectDeployCredentials.revoked_at),
        ),
      )
      .returning();
    return revoked ?? null;
  });
  if (row === 'project-not-found') {
    return context.json({ error: 'project not found' }, 404);
  }
  if (!row) {
    return context.json({ error: 'active credential not found' }, 404);
  }
  return context.json({ ok: true, id: row.id });
});

export default app;
