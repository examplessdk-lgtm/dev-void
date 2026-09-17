import { Hono } from 'hono';
import { getAllUsers, countUsers, searchUsers } from '../../db.ts';
import type { ApiEnv } from '../../env.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import {
  changeOperatorUserPlan,
  deleteOperatorUser,
  getOperatorUser,
  restoreOperatorUser,
  suspendOperatorUser,
} from '../../operator/tenant-service.ts';
import { renderOperationError } from '../operation-error.tsx';
import { UserDetailPage } from '../views/user-detail.tsx';
import { UsersListPage } from '../views/users-list.tsx';

const PAGE_SIZE = 20;
const app = new Hono<ApiEnv>();
app.onError(renderOperationError);

// GET /users
app.get('/', async (context) => {
  const search = context.req.query('search');
  if (search) {
    const users = await searchUsers(context.get('db'), search);
    return context.html(
      <UsersListPage users={users} search={search} username={context.get('user').login} />,
    );
  }
  const page = Math.max(1, parseInt(context.req.query('page') ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const [users, total] = await Promise.all([
    getAllUsers(context.get('db'), PAGE_SIZE, offset),
    countUsers(context.get('db')),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return context.html(
    <UsersListPage
      users={users}
      page={page}
      totalPages={totalPages}
      username={context.get('user').login}
    />,
  );
});

// GET /users/:id
app.get('/:id', async (context) => {
  const detail = await getOperatorUser(context, context.req.param('id'));
  return context.html(<UserDetailPage {...detail} username={context.get('user').login} />);
});

app.post('/:id/plan', async (context) => {
  const body = await context.req.parseBody();
  const userId = context.req.param('id');
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`users/${userId}/plan`, { plan: body.plan }),
    async () => {
      await changeOperatorUserPlan(context, userId, String(body.plan ?? ''));
      return { response: context.redirect(`/admin/users/${userId}`), succeeded: true };
    },
  );
});

app.post('/:id/suspend', async (context) => {
  const body = await context.req.parseBody();
  const userId = context.req.param('id');
  const reason = String(body.reason || 'admin_suspended');
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`users/${userId}/suspend`, { reason }),
    async () => {
      await suspendOperatorUser(context, userId, reason);
      return { response: context.redirect(`/admin/users/${userId}`), succeeded: true };
    },
  );
});

app.post('/:id/unsuspend', async (context) => {
  const userId = context.req.param('id');
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`users/${userId}/restore`),
    async () => {
      await restoreOperatorUser(context, userId);
      return { response: context.redirect(`/admin/users/${userId}`), succeeded: true };
    },
  );
});

app.post('/:id/delete', async (context) => {
  const userId = context.req.param('id');
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`users/${userId}/delete`),
    async () => {
      await deleteOperatorUser(context, userId);
      return { response: context.redirect('/admin/users'), succeeded: true };
    },
  );
});

export default app;
