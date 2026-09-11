import type { CliVersionDeploymentStats } from '../../db.ts';
import { formatDateTime, formatNumber } from './format.ts';
import { Layout } from './layout.tsx';

function CliVersionTable({
  rows,
  title,
  tz,
}: {
  rows: ReadonlyArray<CliVersionDeploymentStats>;
  title: string;
  tz?: string;
}) {
  return (
    <>
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p>
          <em>No deployments found.</em>
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Deploys</th>
              <th>Projects</th>
              <th>Users</th>
              <th>First Seen</th>
              <th>Last Seen</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.cli_version ?? 'unknown'}>
                <td>{row.cli_version ?? 'unknown'}</td>
                <td>{formatNumber(row.deployments)}</td>
                <td>{formatNumber(row.projects)}</td>
                <td>{formatNumber(row.users)}</td>
                <td>{formatDateTime(row.first_seen, tz)}</td>
                <td>{formatDateTime(row.last_seen, tz)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

export function CliVersionsPage({
  allTime,
  last30Days,
  username,
  tz,
}: {
  allTime: ReadonlyArray<CliVersionDeploymentStats>;
  last30Days: ReadonlyArray<CliVersionDeploymentStats>;
  username?: string;
  tz?: string;
}) {
  return (
    <Layout title="CLI Versions" username={username}>
      <h1>CLI Versions</h1>
      <CliVersionTable rows={last30Days} title="Last 30 Days" tz={tz} />
      <CliVersionTable rows={allTime} title="All Time" tz={tz} />
    </Layout>
  );
}
