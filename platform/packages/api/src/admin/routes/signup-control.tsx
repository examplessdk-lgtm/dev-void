import { Hono } from 'hono';
import { AuthenticationConfigurationError } from '../../auth/configuration.ts';
import type { ApiEnv } from '../../env.ts';
import {
  allowOperatorSignup,
  getOperatorSignup,
  parseAccessList,
  removeOperatorSignup,
  setOperatorSignup,
} from '../../operator/access-service.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import { configureAuthenticationAdmission } from '../../operator/auth-config.ts';
import { OperatorError } from '../../operator/common.ts';
import { getPlatformDisplayName } from '../../platform-identity.ts';
import { getAllowlist } from '../../signup-allowlist.ts';
import { renderFateListPage } from '../fate/render.ts';
import { renderOperationError } from '../operation-error.tsx';
import { renderAdminPage } from '../react/server.ts';
import { admissionFormBody } from './auth-config.tsx';

const app = new Hono<ApiEnv>();
app.onError((error, context) =>
  error instanceof AuthenticationConfigurationError
    ? renderAdminPage(
        context,
        'authError',
        'Access',
        {
          message: error.message,
          platformName: getPlatformDisplayName(context.env, context.req.url),
          username: context.get('user')?.login,
        },
        { status: error.status },
      )
    : renderOperationError(error, context),
);

app.get('/', (context) => renderFateListPage(context, 'signupControl'));

app.post('/policy', async (context) => {
  const body = admissionFormBody(await context.req.parseBody({ all: true }));
  return executeAuditedMutation(
    context,
    operatorAuditIntent('config/auth/admission', body),
    async () => {
      await configureAuthenticationAdmission(context, body);
      return { response: context.redirect('/admin/signup-control'), succeeded: true };
    },
  );
});

app.post('/toggle', async (context) => {
  const current = (await getOperatorSignup(context)).enabled;
  const enabled = !current;
  return executeAuditedMutation(
    context,
    operatorAuditIntent(enabled ? 'signup/restrict' : 'signup/open'),
    async () => {
      await setOperatorSignup(context, enabled);
      return { response: context.redirect('/admin/signup-control'), succeeded: true };
    },
  );
});

app.post('/add', async (context) => {
  const body = await context.req.parseBody();
  const type = String(body.type ?? '');
  const note = String(body.note ?? '');
  const patterns = type === 'identity' ? [] : parseAccessList(String(body.pattern ?? ''));
  const entries =
    type === 'identity'
      ? [
          {
            type,
            connectionId: String(body.connectionId ?? ''),
            subject: String(body.subject ?? ''),
            ...(note ? { note } : {}),
          },
        ]
      : patterns.map((pattern) => ({
          type,
          pattern,
          ...(note ? { note } : {}),
        }));
  return executeAuditedMutation(
    context,
    operatorAuditIntent(
      'signup/allow',
      type === 'identity'
        ? {
            type,
            connectionId: String(body.connectionId ?? ''),
            subject: String(body.subject ?? ''),
            note,
          }
        : { type, patterns, note },
    ),
    async () => {
      await allowOperatorSignup(context, entries);
      return { response: context.redirect('/admin/signup-control'), succeeded: true };
    },
  );
});

app.post('/delete', async (context) => {
  const body = await context.req.parseBody();
  const index = Number(body.index);
  const entries = await getAllowlist(context.env.ROUTING);
  if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
    throw new OperatorError(400, 'Invalid index');
  }
  const entry = entries[index];
  return executeAuditedMutation(context, operatorAuditIntent('signup/remove', entry), async () => {
    await removeOperatorSignup(context, entry);
    return { response: context.redirect('/admin/signup-control'), succeeded: true };
  });
});

export default app;
