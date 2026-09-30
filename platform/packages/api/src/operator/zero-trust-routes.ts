import { Hono } from 'hono';
import { getProject, type Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import {
  ZeroTrustConfigurationError,
  normalizeZeroTrustConfigureInput,
  readZeroTrustConfigurationStrict,
  redactedZeroTrustConfiguration,
} from '../zero-trust/configuration.ts';
import {
  configurePlatformZeroTrust,
  disablePlatformZeroTrust,
  getProjectZeroTrustState,
  reconcilePlatformZeroTrust,
  reconcileProjectZeroTrust,
  setProjectZeroTrustProtection,
  zeroTrustStatus,
  ZeroTrustUnavailableError,
} from '../zero-trust/service.ts';
import { dryRun, OperatorError, preview, readBody } from './common.ts';

export const zeroTrustOperatorRoutes = new Hono<ApiEnv>();

async function requireOperatorProject(db: Db, projectId: string, active: boolean): Promise<void> {
  const project = await getProject(db, projectId);
  if (!project) {
    throw new OperatorError(404, 'Project not found.', 'not_found');
  }
  if (active && project.status === 'deleting') {
    throw new OperatorError(409, 'Project is being deleted.', 'project_deleting');
  }
}

function operationError(error: unknown): never {
  if (error instanceof ZeroTrustConfigurationError) {
    throw new OperatorError(400, error.message, 'invalid_zero_trust_configuration');
  }
  if (error instanceof ZeroTrustUnavailableError) {
    throw new OperatorError(error.status, error.message, 'zero_trust_unavailable');
  }
  console.error('[zero-trust] operator operation failed', error);
  throw new OperatorError(
    502,
    'Cloudflare Zero Trust reconciliation failed. Inspect the saved status before retrying.',
    'zero_trust_reconciliation_failed',
  );
}

zeroTrustOperatorRoutes.get('/zero-trust', async (context) =>
  context.json(await zeroTrustStatus(context.env, context.get('db'))),
);

zeroTrustOperatorRoutes.post('/zero-trust/configure', async (context) => {
  const body = await readBody(context);
  let input;
  try {
    input = normalizeZeroTrustConfigureInput(body);
  } catch (error) {
    operationError(error);
  }
  if (dryRun(body)) {
    return context.json(
      preview('zero-trust.configure', 'platform', {
        accountId: input.accountId,
        identityProviderIds: input.identityProviderIds,
        policyIds: input.policyIds,
        protectNewProjects: input.protectNewProjects,
        existingProjects: input.existingProjects,
        credential: 'replace-encrypted',
      }),
    );
  }
  try {
    return context.json({
      ok: true,
      configuration: await configurePlatformZeroTrust(context.env, context.get('db'), input),
    });
  } catch (error) {
    operationError(error);
  }
});

zeroTrustOperatorRoutes.post('/zero-trust/reconcile', async (context) => {
  const body = await readBody(context);
  if (dryRun(body)) {
    return context.json(
      preview('zero-trust.reconcile', 'platform', {
        configuration: redactedZeroTrustConfiguration(
          await readZeroTrustConfigurationStrict(context.get('db')),
        ),
      }),
    );
  }
  try {
    return context.json({
      ok: true,
      configuration: await reconcilePlatformZeroTrust(context.env, context.get('db')),
    });
  } catch (error) {
    operationError(error);
  }
});

zeroTrustOperatorRoutes.post('/zero-trust/disable', async (context) => {
  const body = await readBody(context);
  if (dryRun(body)) {
    return context.json(
      preview('zero-trust.disable', 'platform', {
        configuration: redactedZeroTrustConfiguration(
          await readZeroTrustConfigurationStrict(context.get('db')),
        ),
        result: 'All project hostnames become public.',
      }),
    );
  }
  try {
    return context.json({
      ok: true,
      configuration: await disablePlatformZeroTrust(context.env, context.get('db')),
    });
  } catch (error) {
    operationError(error);
  }
});

zeroTrustOperatorRoutes.get('/zero-trust/projects/:id', async (context) => {
  const projectId = context.req.param('id');
  await requireOperatorProject(context.get('db'), projectId, false);
  return context.json({
    project: await getProjectZeroTrustState(context.get('db'), projectId),
  });
});

zeroTrustOperatorRoutes.post('/zero-trust/projects/:id', async (context) => {
  const body = await readBody(context);
  if (typeof body.protected !== 'boolean') {
    throw new OperatorError(400, 'protected must be a boolean.', 'invalid_argument');
  }
  const projectId = context.req.param('id');
  await requireOperatorProject(context.get('db'), projectId, true);
  if (dryRun(body)) {
    return context.json(
      preview('zero-trust.project', projectId, {
        previous: await getProjectZeroTrustState(context.get('db'), projectId),
        protected: body.protected,
      }),
    );
  }
  try {
    return context.json({
      ok: true,
      project: await setProjectZeroTrustProtection(
        context.env,
        context.get('db'),
        projectId,
        body.protected,
      ),
    });
  } catch (error) {
    operationError(error);
  }
});

zeroTrustOperatorRoutes.post('/zero-trust/projects/:id/reconcile', async (context) => {
  const body = await readBody(context);
  const projectId = context.req.param('id');
  await requireOperatorProject(context.get('db'), projectId, true);
  if (dryRun(body)) {
    return context.json(
      preview('zero-trust.project-reconcile', projectId, {
        project: await getProjectZeroTrustState(context.get('db'), projectId),
      }),
    );
  }
  try {
    return context.json({
      ok: true,
      project: await reconcileProjectZeroTrust(context.env, context.get('db'), projectId),
    });
  } catch (error) {
    operationError(error);
  }
});
