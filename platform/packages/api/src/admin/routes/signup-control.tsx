import { Hono } from 'hono';
import type { ApiEnv } from '../../env.ts';
import {
  allowOperatorSignup,
  getOperatorSignup,
  parseAccessList,
  removeOperatorSignup,
  setOperatorSignup,
} from '../../operator/access-service.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import { OperatorError } from '../../operator/common.ts';
import { getAllowlist } from '../../signup-allowlist.ts';
import { renderOperationError } from '../operation-error.tsx';
import { SignupControlPage } from '../views/signup-control.tsx';

const app = new Hono<ApiEnv>();
app.onError(renderOperationError);

app.get('/', async (context) => {
  const signup = await getOperatorSignup(context);
  return context.html(<SignupControlPage {...signup} username={context.get('user').login} />);
});

app.post('/toggle', async (context) => {
  const current = (await context.env.ROUTING.get('signup:enabled')) === 'true';
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
  const patterns = parseAccessList(String(body.pattern ?? ''));
  const note = String(body.note ?? '');
  return executeAuditedMutation(
    context,
    operatorAuditIntent('signup/allow', { type, patterns, note }),
    async () => {
      await allowOperatorSignup(context, type, patterns, note);
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
  return executeAuditedMutation(
    context,
    operatorAuditIntent('signup/remove', { type: entry.type, pattern: entry.pattern }),
    async () => {
      await removeOperatorSignup(context, entry.type, entry.pattern);
      return { response: context.redirect('/admin/signup-control'), succeeded: true };
    },
  );
});

export default app;
