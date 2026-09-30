import { Hono } from 'hono';
import type { ApiEnv } from '../env.ts';
import {
  ZeroTrustConfigurationError,
  readZeroTrustConfigurationStrict,
} from '../zero-trust/configuration.ts';
import {
  getProjectZeroTrustState,
  publicProjectZeroTrustState,
  reconcileProjectZeroTrust,
  setProjectZeroTrustProtection,
  ZeroTrustUnavailableError,
} from '../zero-trust/service.ts';
import { requireProjectRouteCapability } from './project-access.ts';

const app = new Hono<ApiEnv>()
  .get('/:id/zero-trust', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'read');
    if (access instanceof Response) {
      return access;
    }
    let configuration;
    try {
      configuration = await readZeroTrustConfigurationStrict(context.get('db'));
    } catch (error) {
      if (!(error instanceof ZeroTrustConfigurationError)) {
        throw error;
      }
      return context.json({
        available: false,
        platformStatus: 'invalid_configuration',
        protectNewProjects: false,
        project: publicProjectZeroTrustState(
          await getProjectZeroTrustState(context.get('db'), projectId),
        ),
      });
    }
    const state = await getProjectZeroTrustState(context.get('db'), projectId);
    return context.json({
      available: !!configuration?.enabled,
      platformStatus: configuration?.status ?? 'not_configured',
      protectNewProjects: configuration?.protectNewProjects ?? false,
      project: publicProjectZeroTrustState(state),
    });
  })
  .put('/:id/zero-trust', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'settings');
    if (access instanceof Response) {
      return access;
    }
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: 'a JSON body is required' }, 400);
    }
    const protectedProject =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>).protected
        : undefined;
    if (typeof protectedProject !== 'boolean') {
      return context.json({ error: 'protected must be a boolean' }, 400);
    }
    try {
      const project = await setProjectZeroTrustProtection(
        context.env,
        context.get('db'),
        projectId,
        protectedProject,
      );
      return context.json({ ok: true, project: publicProjectZeroTrustState(project) });
    } catch (error) {
      if (error instanceof ZeroTrustUnavailableError) {
        return context.json({ error: error.message }, error.status);
      }
      console.error('[zero-trust] project update failed', { projectId, error });
      return context.json(
        {
          error: 'Zero Trust reconciliation failed. Protection remains fail closed; retry later.',
        },
        502,
      );
    }
  })
  .post('/:id/zero-trust/reconcile', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'settings');
    if (access instanceof Response) {
      return access;
    }
    try {
      return context.json({
        ok: true,
        project: publicProjectZeroTrustState(
          await reconcileProjectZeroTrust(context.env, context.get('db'), projectId),
        ),
      });
    } catch (error) {
      if (error instanceof ZeroTrustUnavailableError) {
        return context.json({ error: error.message }, error.status);
      }
      console.error('[zero-trust] project reconcile failed', { projectId, error });
      return context.json({ error: 'Zero Trust reconciliation failed.' }, 502);
    }
  });

export default app;
