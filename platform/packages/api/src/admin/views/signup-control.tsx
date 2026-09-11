import type { AllowlistEntryStatus } from '../../db.ts';
import { Layout } from './layout.tsx';

function BooleanBadge({ value }: { value: boolean }) {
  return <strong style={`color: ${value ? 'green' : '#666'}`}>{value ? 'yes' : 'no'}</strong>;
}

export function SignupControlPage({
  enabled,
  entries,
  username,
}: {
  enabled: boolean;
  entries: ReadonlyArray<AllowlistEntryStatus>;
  username?: string;
}) {
  return (
    <Layout title="Signup Control" username={username}>
      <h1>Signup Control</h1>

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

      {/* Entries table */}
      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>Pattern</th>
            <th>Note</th>
            <th>Accepted</th>
            <th>Deployed</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, i) => (
            <tr key={`${entry.type}-${entry.pattern}`}>
              <td>{entry.type}</td>
              <td>{entry.pattern}</td>
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
