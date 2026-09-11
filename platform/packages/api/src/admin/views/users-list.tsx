import type { User } from '../../types.ts';
import { Layout } from './layout.tsx';
import { Pagination } from './pagination.tsx';

export function UsersListPage({
  users,
  search,
  page,
  totalPages,
  username,
}: {
  users: ReadonlyArray<User>;
  search?: string;
  page?: number;
  totalPages?: number;
  username?: string;
}) {
  return (
    <Layout title="Users" username={username}>
      <h1>Users</h1>
      <form method="get" action="/admin/users" style="margin-bottom: 10px">
        <input type="text" name="search" placeholder="Search users..." value={search ?? ''} />{' '}
        <button type="submit">Search</button>
        {search && (
          <>
            {' '}
            | <a href="/admin/users">Clear</a>
          </>
        )}
      </form>
      <table>
        <thead>
          <tr>
            <th>Login</th>
            <th>Provider</th>
            <th>Email</th>
            <th>Plan</th>
            <th>Role</th>
            <th>Status</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id}>
              <td>
                <a href={`/admin/users/${user.id}`}>{user.login}</a>
              </td>
              <td>{user.provider}</td>
              <td>{user.email ?? '-'}</td>
              <td>{user.plan}</td>
              <td>{user.role}</td>
              <td>{user.suspended_reason ? 'suspended' : 'active'}</td>
              <td>{new Date(user.created_at).toLocaleDateString()}</td>
              <td>
                <form
                  method="post"
                  action={`/admin/users/${user.id}/delete`}
                  style="display: inline"
                  onsubmit={`return confirm('Delete user "${user.login}" and all their projects?')`}
                >
                  <button type="submit" class="danger-sm">
                    delete
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {users.length === 0 && (
        <p>
          <em>No users found.</em>
        </p>
      )}
      {page != null && totalPages != null && (
        <Pagination page={page} totalPages={totalPages} baseUrl="/admin/users" />
      )}
    </Layout>
  );
}
