import type { PlatformAdmissionPolicy } from '@void/platform';
import type { AllowlistEntryStatus } from '../../db.ts';
import { Layout } from './layout.tsx';

function BooleanBadge({ value }: { value: boolean }) {
  return <strong style={`color: ${value ? 'green' : '#666'}`}>{value ? 'yes' : 'no'}</strong>;
}

export function SignupControlPage({
  enabled,
  entries,
  username,
  admission,
  connections,
}: {
  enabled: boolean;
  entries: ReadonlyArray<AllowlistEntryStatus>;
  username?: string;
  admission?: PlatformAdmissionPolicy;
  connections: ReadonlyArray<{ id: string; kind: string; label: string }>;
}) {
  return (
    <Layout title="Signup Control" username={username}>
      <h1>Signup Control</h1>
      {admission?.mode === 'company' && (
        <p>
          Company-approved users can join automatically. Manage the company policy in{' '}
          <a href="/admin/config/auth">authentication settings</a>.
        </p>
      )}

      {/* Toggle */}
      <form method="post" action="/admin/signup-control/toggle" style="margin-bottom: 20px">
        <span>
          Signup restriction:{' '}
          <strong style={enabled ? 'color: red' : 'color: green'}>
            {enabled ? 'ON (restricted)' : 'OFF (open)'}
          </strong>
        </span>{' '}
        <button type="submit">{enabled ? 'Disable' : 'Enable'}</button>
      </form>

      {/* Add entry form */}
      <form
        method="post"
        action="/admin/signup-control/add"
        style="margin-bottom: 20px; display: flex; gap: 8px; align-items: flex-start"
      >
        <select name="type">
          <option value="github">GitHub username</option>
          <option value="email">Email / pattern</option>
        </select>
        <textarea
          name="pattern"
          placeholder="username, teammate@example.com, *@domain.com"
          required
          rows={3}
          style="width: 360px"
        />
        <input type="text" name="note" placeholder="Note (optional)" style="width: 150px" />
        <button type="submit">Add</button>
      </form>

      {connections.length > 0 && (
        <form
          method="post"
          action="/admin/signup-control/add"
          style="margin-bottom: 20px; display: flex; gap: 8px; align-items: flex-start"
        >
          <input type="hidden" name="type" value="identity" />
          <select name="connectionId" aria-label="Login connection">
            {connections.map((connection) => (
              <option value={connection.id} key={connection.id}>
                {connection.label} ({connection.id})
              </option>
            ))}
          </select>
          <input
            type="text"
            name="subject"
            placeholder="Exact provider subject"
            required
            maxlength={255}
            style="width: 360px"
          />
          <input type="text" name="note" placeholder="Note (optional)" style="width: 150px" />
          <button type="submit">Add identity</button>
        </form>
      )}
      <p>
        Identity grants match the selected login connection and provider subject exactly, including
        case. Email is not inferred or linked.
      </p>

      {/* Entries table */}
      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>Grant</th>
            <th>Note</th>
            <th>Accepted</th>
            <th>Deployed</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, i) => (
            <tr
              key={
                entry.type === 'identity'
                  ? `${entry.type}-${entry.connectionId}-${entry.subject}`
                  : `${entry.type}-${entry.pattern}`
              }
            >
              <td>{entry.type}</td>
              <td>
                {entry.type === 'identity'
                  ? `${entry.connectionId}: ${entry.subject}`
                  : entry.pattern}
              </td>
              <td>{entry.note || '-'}</td>
              <td>
                <BooleanBadge value={entry.accepted} />
              </td>
              <td>
                <BooleanBadge value={entry.deployed} />
              </td>
              <td>
                <form method="post" action="/admin/signup-control/delete" style="display: inline">
                  <input type="hidden" name="index" value={String(i)} />
                  <button type="submit" class="danger-sm">
                    delete
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {entries.length === 0 && (
        <p>
          <em>
            No entries.{' '}
            {enabled
              ? 'All signups are blocked. Add entries to allow specific users.'
              : 'All signups are allowed.'}
          </em>
        </p>
      )}
    </Layout>
  );
}
