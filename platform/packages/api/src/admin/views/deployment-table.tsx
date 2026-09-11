import type { Deployment } from '../../types.ts';
import { formatDateTime } from './format.ts';

export function displayStatus(
  d: Deployment,
  activeDeploymentId: string | null | undefined,
): string {
  if (d.status === 'failed') {
    return 'failed';
  }
  if (d.status !== 'live') {
    return d.status;
  }
  if (d.id === activeDeploymentId) {
    return 'live';
  }
  if (d.retained) {
    return 'retained';
  }
  return 'evicted';
}

function statusColor(status: string): string | undefined {
  switch (status) {
    case 'live':
      return 'color: #16a34a; font-weight: 600';
    case 'retained':
      return 'color: #16a34a';
    case 'evicted':
      return 'color: #888';
    case 'failed':
    case 'canceled':
      return 'color: #dc2626';
    case 'canceling':
      return 'color: #ca8a04';
    default:
      return undefined;
  }
}

export function DeploymentTable({
  deployments,
  activeDeploymentId,
  showProject,
  tz,
}: {
  deployments: ReadonlyArray<
    Deployment & {
      project_slug?: string | null;
      active_deployment_id?: string | null;
    }
  >;
  activeDeploymentId?: string | null;
  showProject?: boolean;
  tz?: string;
}) {
  if (deployments.length === 0) {
    return (
      <p>
        <em>No deployments found.</em>
      </p>
    );
  }
  return (
    <table>
      <thead>
        <tr>
          <th>ID</th>
          {showProject && <th>Project</th>}
          <th>Status</th>
          <th>Source</th>
          <th>CLI</th>
          <th>Commit</th>
          <th>Error</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {deployments.map((d) => {
          const activeId = activeDeploymentId ?? d.active_deployment_id;
          const status = displayStatus(d, activeId);
          return (
            <tr key={d.id}>
              <td>
                <a href={`/admin/deployments/${d.id}`}>{d.id}</a>
              </td>
              {showProject && (
                <td>
                  {d.project_slug ? (
                    <a href={`/admin/projects/${d.project_id}`}>{d.project_slug}</a>
                  ) : (
                    '-'
                  )}
                </td>
              )}
              <td style={statusColor(status)}>{status}</td>
              <td>{d.source ?? '-'}</td>
              <td>{d.cli_version ?? '-'}</td>
              <td>{d.commit ? d.commit.slice(0, 7) : '-'}</td>
              <td>
                {d.error_message ? (
                  <>
                    <span style="color: red; max-width: 400px; display: inline-block; word-break: break-word">
                      {d.error_message}
                    </span>
                    <br />
                    <button
                      type="button"
                      class="copy-btn"
                      data-copy={d.error_message}
                      style="font-size: 0.65rem; padding: 1px 5px; float: right; margin-top: 5px"
                    >
                      copy
                    </button>
                  </>
                ) : (
                  '-'
                )}
              </td>
              <td>{formatDateTime(d.created_at, tz)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
