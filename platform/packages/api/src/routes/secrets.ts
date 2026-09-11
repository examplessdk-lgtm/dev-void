import { Hono } from 'hono';
import {
  DEFAULT_DISPATCH_NAMESPACE,
  MAX_SECRET_NAME_LENGTH,
  MAX_SECRET_VALUE_BYTES,
} from '../constants.ts';
import {
  deleteProjectSecret,
  getProject,
  listProjectSecretNames,
  upsertProjectSecret,
} from '../db.ts';
import type { ApiEnv } from '../env.ts';
import {
  deleteWorkerSecret,
  encryptProjectSecret,
  getVersionedWorkerName,
  putWorkerSecret,
} from '../project-secrets.ts';
import { isReservedBindingName } from '../reserved-bindings.ts';

function isValidSecretName(name: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(name);
}

const app = new Hono<ApiEnv>()

  .get('/:id/secrets', async (context) => {
    const projectId = context.req.param('id');
    const project = await getProject(context.get('db'), projectId);
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }

    return context.json(await listProjectSecretNames(context.get('db'), projectId));
  })

  .put('/:id/secrets/:name', async (context) => {
    const projectId = context.req.param('id');
    const secretName = context.req.param('name');
    if (!isValidSecretName(secretName)) {
      return context.json({ error: 'invalid secret name' }, 400);
    }
    if (secretName.length > MAX_SECRET_NAME_LENGTH) {
      return context.json({ error: 'secret name too long' }, 400);
    }
    // Reject before we encrypt and persist. The deploy pipeline rejects the
    // same set, but only at the next deploy — far from the action that caused
    // it. DELETE deliberately stays unguarded so a row stored before this
    // guard existed can still be cleaned up.
    if (isReservedBindingName(secretName)) {
      return context.json({ error: 'reserved binding name' }, 400);
    }

    const project = await getProject(context.get('db'), projectId);
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }

    let body: { value?: string } = {};
    try {
      body = await context.req.json<{ value?: string }>();
    } catch {
      body = {};
    }
    if (typeof body.value !== 'string' || body.value.length === 0) {
      return context.json({ error: 'value is required' }, 400);
    }
    if (new TextEncoder().encode(body.value).byteLength > MAX_SECRET_VALUE_BYTES) {
      return context.json({ error: 'secret value too large' }, 400);
    }

    const encrypted = await encryptProjectSecret(context.env, projectId, secretName, body.value);
    await upsertProjectSecret(
      context.get('db'),
      projectId,
      secretName,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.keyVersion,
    );

    if (project.active_deployment_id) {
      const dispatchNamespace = context.env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
      const workerName = getVersionedWorkerName(project.slug, project.active_deployment_id);
      try {
        await putWorkerSecret(context.env, dispatchNamespace, workerName, secretName, body.value);
      } catch (error) {
        return context.json(
          {
            error: 'secret stored but live propagation failed',
            name: secretName,
            liveUpdated: false,
            details: error instanceof Error ? error.message : String(error),
          },
          502,
        );
      }
    }

    return context.json({ ok: true, name: secretName });
  })

  .delete('/:id/secrets/:name', async (context) => {
    const projectId = context.req.param('id');
    const secretName = context.req.param('name');
    if (!isValidSecretName(secretName)) {
      return context.json({ error: 'invalid secret name' }, 400);
    }

    const project = await getProject(context.get('db'), projectId);
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }

    await deleteProjectSecret(context.get('db'), projectId, secretName);

    if (project.active_deployment_id) {
      const dispatchNamespace = context.env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
      const workerName = getVersionedWorkerName(project.slug, project.active_deployment_id);
      try {
        await deleteWorkerSecret(context.env, dispatchNamespace, workerName, secretName);
      } catch (error) {
        return context.json(
          {
            error: 'secret deleted from storage but live propagation failed',
            name: secretName,
            liveUpdated: false,
            details: error instanceof Error ? error.message : String(error),
          },
          502,
        );
      }
    }

    return context.json({ ok: true, name: secretName });
  });

export default app;
