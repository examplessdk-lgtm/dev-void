import { Hono } from 'hono';
import { getAllUsers, countUsers, searchUsers } from '../../db.ts';
import type { ApiEnv } from '../../env.ts';
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
  await changeOperatorUserPlan(context, context.req.param('id'), String(body.plan ?? ''));
  return context.redirect(`/admin/users/${context.req.param('id')}`);
});

app.post('/:id/suspend', async (context) => {
  const body = await context.req.parseBody();
  await suspendOperatorUser(
    context,
    context.req.param('id'),
    String(body.reason || 'admin_suspended'),
  );
  return context.redirect(`/admin/users/${context.req.param('id')}`);
});

app.post('/:id/unsuspend', async (context) => {
  await restoreOperatorUser(context, context.req.param('id'));
  return context.redirect(`/admin/users/${context.req.param('id')}`);
});

app.post('/:id/delete', async (context) => {
  await deleteOperatorUser(context, context.req.param('id'));
  return context.redirect('/admin/users');
});

export default app;
