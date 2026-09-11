import type { WorkerVersion, WorkerDeployment } from '../../provisioning/workers-versions.ts';
import type { PlatformWorker, PlatformEnv } from '../platform-workers.ts';
import { formatDateTime } from './format.ts';
import { Layout } from './layout.tsx';

export function PlatformWorkerDetailPage({
  worker,
  env,
  scriptName,
  versions,
  deployment,
  error,
  username,
  tz,
}: {
  worker: PlatformWorker;
  env: PlatformEnv;
  scriptName: string;
  versions: ReadonlyArray<WorkerVersion>;
  deployment?: WorkerDeployment;
  error?: string;
  username: string;
  tz?: string;
}) {
  const activeVersionId = deployment?.versions.find((v) => v.percentage === 100)?.version_id;

  return (
    <Layout title={`${worker.name} — Platform`} username={username}>
      <p style="margin-bottom: 16px">
        <a href={'/admin/platform'}>&larr; Back to Platform</a>
      </p>

      <h1>{worker.name}</h1>

      <table style="width: auto; margin-bottom: 24px">
        <tbody>
          <tr>
            <td style="font-weight: 600; padding-right: 24px">Script</td>
            <td>{scriptName}</td>
          </tr>
          <tr>
            <td style="font-weight: 600; padding-right: 24px">Environment</td>
            <td>{env}</td>
          </tr>
          <tr>
            <td style="font-weight: 600; padding-right: 24px">Deploy order</td>
            <td>{worker.deployOrder}</td>
          </tr>
          {worker.dependsOn.length > 0 && (
            <tr>
              <td style="font-weight: 600; padding-right: 24px">Depends on</td>
              <td>{worker.dependsOn.join(', ')}</td>
            </tr>
          )}
          {worker.dependedBy.length > 0 && (
            <tr>
              <td style="font-weight: 600; padding-right: 24px">Depended by</td>
              <td>{worker.dependedBy.join(', ')}</td>
            </tr>
          )}
        </tbody>
      </table>

      {worker.rollbackWarning && (
        <div style="background: #fef3c7; border: 1px solid #f59e0b; padding: 12px; margin-bottom: 24px; font-size: 0.85rem">
          <strong>Warning:</strong> {worker.rollbackWarning}
        </div>
      )}

      <h2 style="margin-top: 0">Versions</h2>

      {error && (
        <div style="background: #fee2e2; border: 1px solid #dc2626; padding: 12px; margin-bottom: 16px; font-size: 0.85rem">
          <strong>Error:</strong> {error}
        </div>
      )}

      {versions.length === 0 && !error ? (
        <p>
          <em>No versions found.</em>
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Version ID</th>
              <th>#</th>
              <th>Created</th>
              <th>Author</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => {
              const isActive = v.id === activeVersionId;
              return (
                <tr key={v.id} style={isActive ? 'background: #dcfce7' : undefined}>
                  <td>
                    <span class="copy-btn" data-copy={v.id} style="cursor: pointer">
                      {v.id.slice(0, 12)}...
                    </span>
                  </td>
                  <td>{v.number}</td>
                  <td>{formatDateTime(v.metadata.created_on, tz)}</td>
                  <td>{v.metadata.author_email}</td>
                  <td>
                    {isActive ? (
                      <span style="color: #16a34a; font-weight: 600">active</span>
                    ) : (
                      <span style="color: #6b7280">inactive</span>
                    )}
                  </td>
                  <td>
                    {isActive ? (
                      '—'
                    ) : (
                      <form
                        method="post"
                        action={`/admin/platform/${worker.name}/rollback`}
                        style="display: inline"
                        onsubmit={`return confirm('Roll back ${worker.name} (${env}) to version #${v.number}?')`}
                      >
                        <input type="hidden" name="version_id" value={v.id} />
                        <button class="danger-sm" type="submit">
                          rollback
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Layout>
  );
}
