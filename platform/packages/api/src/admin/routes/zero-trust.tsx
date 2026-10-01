import { Hono } from 'hono';
import type { ApiEnv } from '../../env.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import { zeroTrustOperatorError } from '../../operator/zero-trust-routes.ts';
import { normalizeZeroTrustConfigureInput } from '../../zero-trust/configuration.ts';
import {
  configurePlatformZeroTrust,
  disablePlatformZeroTrust,
  reconcilePlatformZeroTrust,
} from '../../zero-trust/installation.ts';
import { renderFateListPage } from '../fate/render.ts';
import { renderOperationError } from '../operation-error.tsx';

const app = new Hono<ApiEnv>();
// Set on the final response: admin pages and error pages return their own
// Response objects, which would drop headers prepared with context.header().
app.use('*', async (context, next) => {
  await next();
  context.res.headers.set('Cache-Control', 'no-store');
  context.res.headers.set('Referrer-Policy', 'strict-origin');
});
app.onError(renderOperationError);

function values(value: FormDataEntryValue | undefined): ReadonlyArray<string> {
  return typeof value === 'string'
    ? value
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

function adminError(error: unknown): never {
  throw zeroTrustOperatorError(error, 'admin operation failed');
}

app.get('/', (context) => renderFateListPage(context, 'zeroTrust'));

app.post('/configure', async (context) => {
  const form = await context.req.parseBody();
  let input;
  try {
    input = normalizeZeroTrustConfigureInput({
      apiToken: form.apiToken,
      identityProviderIds: values(form.identityProviderIds),
      policyIds: values(form.policyIds),
      protectNewProjects: form.protectNewProjects === 'yes',
      existingProjects: form.existingProjects,
    });
  } catch (error) {
    adminError(error);
  }
  return executeAuditedMutation(
    context,
    operatorAuditIntent('zero-trust/configure', input),
    async () => {
      try {
        await configurePlatformZeroTrust(context.env, context.get('db'), input, {
          requestUrl: context.req.url,
        });
      } catch (error) {
        adminError(error);
      }
      return { response: context.redirect('/admin/zero-trust'), succeeded: true };
    },
  );
});

app.post('/reconcile', async (context) =>
  executeAuditedMutation(context, operatorAuditIntent('zero-trust/reconcile'), async () => {
    try {
      await reconcilePlatformZeroTrust(context.env, context.get('db'));
    } catch (error) {
      adminError(error);
    }
    return { response: context.redirect('/admin/zero-trust'), succeeded: true };
  }),
);

app.post('/disable', async (context) =>
  executeAuditedMutation(context, operatorAuditIntent('zero-trust/disable'), async () => {
    try {
      await disablePlatformZeroTrust(context.env, context.get('db'));
    } catch (error) {
      adminError(error);
    }
    return { response: context.redirect('/admin/zero-trust'), succeeded: true };
  }),
);

export default app;
