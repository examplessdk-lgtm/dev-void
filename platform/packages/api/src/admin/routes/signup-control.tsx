import { Hono } from 'hono';
import type { ApiEnv } from '../../env.ts';
import {
  allowOperatorSignup,
  getOperatorSignup,
  parseAccessList,
  removeOperatorSignup,
  setOperatorSignup,
} from '../../operator/access-service.ts';
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
  await setOperatorSignup(context, !current);
  return context.redirect('/admin/signup-control');
});

app.post('/add', async (context) => {
  const body = await context.req.parseBody();
  await allowOperatorSignup(
    context,
    String(body.type ?? ''),
    parseAccessList(String(body.pattern ?? '')),
    String(body.note ?? ''),
  );
  return context.redirect('/admin/signup-control');
});

app.post('/delete', async (context) => {
  const body = await context.req.parseBody();
  const index = Number(body.index);
  const entries = await getAllowlist(context.env.ROUTING);
  if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
    throw new OperatorError(400, 'Invalid index');
  }
  const entry = entries[index];
  await removeOperatorSignup(context, entry.type, entry.pattern);
  return context.redirect('/admin/signup-control');
});

export default app;
