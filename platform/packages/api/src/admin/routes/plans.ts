import {
  PLAN_EDITABLE_LIMIT_KEYS,
  parsePlatformPlanId,
  type PlatformPlanCatalog,
} from '@void/platform/plans';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ApiEnv } from '../../env.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import { OperatorError, readBody } from '../../operator/common.ts';
import {
  getOperatorPlanCatalog,
  mutateOperatorPlanCatalog,
  syncOperatorPlanCatalog,
  type PlanCatalogAction,
} from '../../operator/plans.ts';
import { getPlatformDisplayName } from '../../platform-identity.ts';
import { renderFateListPage } from '../fate/render.ts';
import type { AdminPlanPreview, AdminPlanProgress } from '../plans.ts';
import { renderAdminPage } from '../react/server.ts';

const app = new Hono<ApiEnv>();
app.use('*', bodyLimit({ maxSize: 32 * 1024 }));
app.use('*', async (context, next) => {
  await next();
  context.res.headers.set('Referrer-Policy', 'strict-origin');
  context.res.headers.set('Cache-Control', 'no-store');
});
app.onError((error, context) => {
  if (error instanceof OperatorError) {
    return renderAdminPage(
      context,
      'adminError',
      'Plans',
      {
        message: error.message,
        status: error.status,
        platformName: getPlatformDisplayName(context.env, context.req.url),
        username: context.get('user')?.login,
      },
      { status: error.status },
    );
  }
  throw error;
});

const actions: Array<PlanCatalogAction> = ['add', 'set', 'archive', 'remove', 'default', 'reset'];
function action(value: unknown): PlanCatalogAction {
  if (typeof value !== 'string' || !actions.includes(value as PlanCatalogAction)) {
    throw new OperatorError(400, 'Choose a supported plan action.');
  }
  return value as PlanCatalogAction;
}
function planId(value: unknown): string {
  try {
    return parsePlatformPlanId(value);
  } catch {
    throw new OperatorError(400, 'Choose a valid plan ID.');
  }
}

function progress(result: {
  catalog: PlatformPlanCatalog;
  reconciliation: { complete: boolean; processed: number; error?: { message: string } };
}): AdminPlanProgress {
  return {
    revision: result.catalog.revision,
    complete: result.reconciliation.complete,
    processed: result.reconciliation.processed,
    cursor: result.catalog.reconciliation?.cursor ?? null,
    error: result.reconciliation.error?.message ?? null,
  };
}

app.get('/', (context) => renderFateListPage(context, 'plans'));
app.get('/new', (context) => renderFateListPage(context, 'planEdit'));
app.get('/:id/edit', (context) => renderFateListPage(context, 'planEdit'));

app.post('/preview', async (context) => {
  const form = await context.req.parseBody();
  const selectedAction = action(form.action);
  const target = planId(form.id);
  const body: Record<string, unknown> = { expectedRevision: Number(form.revision) };
  if (selectedAction === 'add') {
    body.id = target;
    body.copyFrom = planId(form.copyFrom);
    body.name = form.name;
  } else if (selectedAction === 'set') {
    body.name = form.name;
    body.buildInstanceType = form.buildInstanceType;
    body.allowShortSlugs = form.allowShortSlugs === 'true';
    body.limits = Object.fromEntries(
      PLAN_EDITABLE_LIMIT_KEYS.map((key) => {
        const value = form[key];
        if (typeof value !== 'string' || !/^\d+$/.test(value)) {
          throw new OperatorError(400, 'Enter a nonnegative whole number for every limit.');
        }
        return [key, Number(value)];
      }),
    );
  } else if (selectedAction === 'archive') {
    body.archived = form.archived !== 'false';
  } else if (selectedAction === 'remove' && form.replacementPlanId) {
    body.replacementPlanId = planId(form.replacementPlanId);
  } else if (selectedAction === 'default') {
    body.planId = target;
  }
  const { catalog: before } = await getOperatorPlanCatalog(context);
  const result = await mutateOperatorPlanCatalog(
    context,
    selectedAction,
    selectedAction === 'add' || selectedAction === 'default' ? undefined : target,
    { ...body, dryRun: true },
  );
  if (
    !('overLimitAccounts' in result) ||
    !('expectedRevision' in result) ||
    typeof result.expectedRevision !== 'number'
  ) {
    throw new Error('Plan preview is unavailable.');
  }
  const preview: AdminPlanPreview = {
    action: selectedAction,
    target,
    body,
    expectedRevision: result.expectedRevision,
    before,
    after: result.catalog,
    affectedAccounts: result.affectedAccounts,
    warnings: result.warnings,
    overLimitAccounts: result.overLimitAccounts,
    usageSampleSize: result.usageSampleSize,
  };
  return renderAdminPage(context, 'planPreview', 'Review plan change', {
    preview,
    platformName: getPlatformDisplayName(context.env, context.req.url),
    username: context.get('user').login,
  });
});

app.post('/apply', async (context) => {
  const form = await context.req.parseBody();
  const selectedAction = action(form.action);
  const target = planId(form.id);
  let body: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(String(form.body));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error();
    }
    body = { ...value, expectedRevision: Number(form.revision), dryRun: false };
  } catch {
    throw new OperatorError(400, 'The plan review is invalid. Preview the change again.');
  }
  return executeAuditedMutation(
    context,
    operatorAuditIntent(
      `config/plans/${selectedAction === 'add' || selectedAction === 'default' ? selectedAction : `${target}/${selectedAction}`}`,
      body,
    ),
    async () => {
      const result = await mutateOperatorPlanCatalog(
        context,
        selectedAction,
        selectedAction === 'add' || selectedAction === 'default' ? undefined : target,
        body,
      );
      if (!('reconciliation' in result)) {
        throw new Error('Plan update is unavailable.');
      }
      const state = progress(result);
      return {
        response: await renderAdminPage(context, 'planResult', 'Plan update', {
          initial: state,
          platformName: getPlatformDisplayName(context.env, context.req.url),
          username: context.get('user').login,
        }),
        succeeded: !state.error,
      };
    },
  );
});

app.post('/resume', async (context) => {
  const form = await context.req.parseBody();
  const body = { expectedRevision: Number(form.revision) };
  return executeAuditedMutation(
    context,
    operatorAuditIntent('config/plans/sync', body),
    async () => {
      const state = progress(await syncOperatorPlanCatalog(context, body));
      return {
        response: await renderAdminPage(context, 'planResult', 'Plan update', {
          initial: state,
          platformName: getPlatformDisplayName(context.env, context.req.url),
          username: context.get('user').login,
        }),
        succeeded: !state.error,
      };
    },
  );
});
app.post('/sync', async (context) => {
  const value = await readBody(context);
  const body = { expectedRevision: value.expectedRevision };
  return executeAuditedMutation(
    context,
    operatorAuditIntent('config/plans/sync', body),
    async () => {
      const state = progress(await syncOperatorPlanCatalog(context, body));
      return { response: context.json(state), succeeded: !state.error };
    },
  );
});
export default app;
