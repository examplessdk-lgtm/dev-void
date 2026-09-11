import type { Invitation } from '../../types.ts';
import { Layout } from './layout.tsx';
import { Pagination } from './pagination.tsx';

type InvitationRow = Invitation & {
  invited_by_login: string | null;
  revoked_by_login: string | null;
};

function StatusBadge({ status }: { status: Invitation['status'] }) {
  const colors: Record<string, string> = {
    pending: 'orange',
    accepted: 'green',
    revoked: 'red',
  };
  return <strong style={`color: ${colors[status] ?? 'inherit'}`}>{status}</strong>;
}

export function InvitationsPage({
  invitations,
  page,
  totalPages,
  username,
}: {
  invitations: ReadonlyArray<InvitationRow>;
  page: number;
  totalPages: number;
  username?: string;
}) {
  return (
    <Layout title="Invitations" username={username}>
      <h1>Invitations</h1>

      <form
        method="post"
        action="/admin/invitations/send"
        style="margin-bottom: 20px; display: flex; gap: 8px; align-items: flex-start"
      >
        <textarea
          name="email"
          placeholder="user@example.com, teammate@example.com"
          required
          rows={3}
          style="width: 360px"
        />
        <button type="submit">Send Invites</button>
      </form>

      <table>
        <thead>
          <tr>
            <th>Email</th>
            <th>Status</th>
            <th>Invited By</th>
            <th>Sent</th>
            <th>Accepted At</th>
            <th>Revoked</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {invitations.map((inv) => (
            <tr key={inv.id}>
              <td>{inv.email}</td>
              <td>
                <StatusBadge status={inv.status} />
              </td>
              <td>{inv.invited_by_login ?? inv.invited_by}</td>
              <td>{inv.created_at ? new Date(inv.created_at).toLocaleDateString() : '-'}</td>
              <td>{inv.accepted_at ? new Date(inv.accepted_at).toLocaleDateString() : '-'}</td>
              <td>
                {inv.revoked_at
                  ? `${new Date(inv.revoked_at).toLocaleDateString()} by ${inv.revoked_by_login ?? inv.revoked_by ?? '?'}`
                  : '-'}
              </td>
              <td>
                {inv.status === 'pending' && (
                  <form method="post" action="/admin/invitations/revoke" style="display:inline">
                    <input type="hidden" name="id" value={inv.id} />
                    <button type="submit" class="danger-sm">
                      revoke
                    </button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {invitations.length === 0 && (
        <p>
          <em>No invitations yet.</em>
        </p>
      )}

      <Pagination page={page} totalPages={totalPages} baseUrl="/admin/invitations" />
    </Layout>
  );
}
