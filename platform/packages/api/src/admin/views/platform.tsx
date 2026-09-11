import type { WorkerDeployment } from '../../provisioning/workers-versions.ts';
import type { PlatformWorker, PlatformEnv } from '../platform-workers.ts';
import type { ActivityEntry } from '../routes/platform.tsx';
import { formatDateTime, STATUS_COLORS } from './format.ts';
import { Layout } from './layout.tsx';

type WorkerStatus = Readonly<{
  worker: PlatformWorker;
  scriptName: string;
  deployment?: WorkerDeployment;
  previousVersionId?: string;
  error?: string;
}>;

export function PlatformPage({
  workers,
  env,
  username,
  tz,
  entries,
  page,
  totalPages,
}: {
  workers: ReadonlyArray<WorkerStatus>;
  env: PlatformEnv;
  username: string;
  tz?: string;
  entries: ReadonlyArray<ActivityEntry>;
  page: number;
  totalPages: number;
}) {
  const allHaveRollbackTarget = workers.every((w) => w.previousVersionId);
  const anyHasError = workers.some((w) => w.error);

  return (
    <Layout title="Platform Workers" username={username}>
      <h1>Platform Workers</h1>
      <p style="margin-bottom: 16px">
        Environment: <strong>{env}</strong>
      </p>

      <table>
        <thead>
          <tr>
            <th>Worker</th>
            <th>Script</th>
            <th>Active Version</th>
            <th>Deployed</th>
            <th>Author</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {workers.map(({ worker, scriptName, deployment, error }) => {
            const activeVersion = deployment?.versions.find((v) => v.percentage === 100);
            return (
              <tr key={worker.name}>
                <td>
                  <a href={`/admin/platform/${worker.name}`}>{worker.name}</a>
                  {worker.rollbackWarning && (
                    <span title={worker.rollbackWarning} style="cursor: help">
                      {' '}
                      *
                    </span>
                  )}
                </td>
                <td style="font-size: 0.75rem">{scriptName}</td>
                <td>
                  {error ? (
                    <span style="color: #dc2626">{error}</span>
                  ) : activeVersion ? (
                    <span
                      class="copy-btn"
                      data-copy={activeVersion.version_id}
                      style="cursor: pointer"
                    >
                      {activeVersion.version_id.slice(0, 8)}...
                    </span>
                  ) : (
                    <em>unknown</em>
                  )}
                </td>
                <td>{deployment && !error ? formatDateTime(deployment.created_on, tz) : '—'}</td>
                <td>{deployment && !error ? deployment.author_email : '—'}</td>
                <td>
                  {error ? (
                    <span
                      style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#dc2626"
                      title="Error fetching"
                    />
                  ) : (
                    <span
                      style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#16a34a"
                      title="OK"
                    />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2 style="margin-top: 40px">Rollback All Workers</h2>

      {anyHasError && (
        <div style="background: #fee2e2; border: 1px solid #dc2626; padding: 12px; margin-bottom: 16px; font-size: 0.85rem">
          <strong>Error:</strong> Some workers failed to fetch. Fix errors before using batch
          rollback.
        </div>
      )}

      <div style="background: #fef3c7; border: 1px solid #f59e0b; padding: 12px; margin-bottom: 16px; font-size: 0.85rem">
        <strong>Warning:</strong> Rolling back void-api will also roll back this admin panel. The CF
        API call completes before the old code takes over, so the results page will still render. DB
        migrations are forward-only; schema-compat CI ensures backward compatibility.
      </div>

      <form method="post" action={'/admin/platform/rollback-all'} id="rollback-all-form">
        <table>
          <thead>
            <tr>
              <th>Order</th>
              <th>Worker</th>
              <th>Current Version</th>
              <th>→</th>
              <th>Rollback Target</th>
            </tr>
          </thead>
          <tbody>
            {[...workers]
              .sort((a, b) => b.worker.deployOrder - a.worker.deployOrder)
              .map(({ worker, deployment, previousVersionId, error }) => {
                const activeVersion = deployment?.versions.find((v) => v.percentage === 100);
                return (
                  <tr
                    key={worker.name}
                    class="rollback-row"
                    data-worker={worker.name}
                    data-current={error ? '' : (activeVersion?.version_id ?? '')}
                    data-target={error ? '' : (previousVersionId ?? '')}
                  >
                    <td>{worker.deployOrder}</td>
                    <td>{worker.name}</td>
                    <td>
                      {error ? (
                        <span style="color: #dc2626">error</span>
                      ) : activeVersion ? (
                        activeVersion.version_id.slice(0, 8) + '...'
                      ) : (
                        <em>unknown</em>
                      )}
                    </td>
                    <td style="text-align: center; color: #6b7280">→</td>
                    <td>
                      {error ? (
                        '—'
                      ) : previousVersionId ? (
                        <>
                          <span style="font-size: 0.75rem">{previousVersionId.slice(0, 8)}...</span>
                          <input
                            type="hidden"
                            name={`version_${worker.name}`}
                            value={previousVersionId}
                          />
                        </>
                      ) : (
                        <em style="color: #6b7280">no previous version</em>
                      )}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>

        <button
          class="danger"
          type="submit"
          disabled={!allHaveRollbackTarget || anyHasError}
          style="margin-top: 16px"
        >
          Rollback All Workers
        </button>
      </form>

      <script
        dangerouslySetInnerHTML={{
          __html: `
document.getElementById('rollback-all-form').addEventListener('submit', function(event) {
  event.preventDefault();
  var rows = document.querySelectorAll('.rollback-row');
  var lines = [];
  rows.forEach(function(row) {
    var workerName = row.dataset.worker;
    var current = row.dataset.current;
    var target = row.dataset.target;
    if (current && target) {
      lines.push('  ' + workerName.padEnd(12) + currentarget.slice(0, 12) + ' → ' + target.slice(0, 12));
    }
  });
  var msg = 'Roll back ALL ${env} workers?\\n\\n' + lines.join('\\n') + '\\n\\nThis cannot be undone.';
  if (confirm(msg)) this.submit();
});`,
        }}
      />

      <h2 style="margin-top: 40px">Deploy / Rollback Order</h2>
      <p style="margin-bottom: 8px; font-size: 0.85rem">
        <strong>Deploy order:</strong> proxy (1) → tail (2) → api (3) → dashboard (4) → dispatch (5)
      </p>
      <p style="font-size: 0.85rem">
        <strong>Rollback order (reverse):</strong> dispatch (5) → dashboard (4) → api (3) → tail (2)
        → proxy (1)
      </p>

      <h2 style="margin-top: 40px">Recent Activity</h2>
      {entries.length === 0 ? (
        <p>
          <em>No rollback events recorded yet.</em>
        </p>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Action</th>
                <th>Worker</th>
                <th>Version</th>
                <th>Status</th>
                <th>Admin</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                if (entry.kind === 'single') {
                  const e = entry.event;
                  return (
                    <tr key={e.id}>
                      <td>{formatDateTime(e.created_at, tz)}</td>
                      <td>rollback</td>
                      <td>{e.worker_name}</td>
                      <td style="font-size: 0.75rem">{e.version_id.slice(0, 8)}...</td>
                      <td>
                        <span
                          style={`color: ${STATUS_COLORS[e.status] ?? '#000'}; font-weight: 600`}
                        >
                          {e.status}
                        </span>
                      </td>
                      <td>{e.admin_login}</td>
                    </tr>
                  );
                }

                const first = entry.events[0];
                const succeeded = entry.events.filter((e) => e.status === 'success').length;
                const failed = entry.events.filter((e) => e.status === 'failed').length;
                const skipped = entry.events.filter((e) => e.status === 'skipped').length;
                const statusParts: Array<string> = [];
                if (succeeded > 0) {
                  statusParts.push(`${succeeded} success`);
                }
                if (failed > 0) {
                  statusParts.push(`${failed} failed`);
                }
                if (skipped > 0) {
                  statusParts.push(`${skipped} skipped`);
                }
                const allSuccess = succeeded === entry.events.length;
                const statusColor = failed > 0 ? '#dc2626' : allSuccess ? '#16a34a' : '#d97706';

                return (
                  <tr key={entry.batchId}>
                    <td>{formatDateTime(first.created_at, tz)}</td>
                    <td>rollback_all</td>
                    <td>{entry.events.length} workers</td>
                    <td>
                      <a
                        href={`/admin/platform/events/${entry.batchId}`}
                        style="font-size: 0.75rem"
                      >
                        details →
                      </a>
                    </td>
                    <td>
                      <span style={`color: ${statusColor}; font-weight: 600`}>
                        {statusParts.join(', ')}
                      </span>
                    </td>
                    <td>{first.admin_login}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {totalPages > 1 && (
            <div style="margin-top: 12px; font-size: 0.85rem">
              {page > 1 ? (
                <a href={`/admin/platform?page=${page - 1}`}>← Previous</a>
              ) : (
                <span style="color: #9ca3af">← Previous</span>
              )}
              <span style="margin: 0 12px">
                Page {page} of {totalPages}
              </span>
              {page < totalPages ? (
                <a href={`/admin/platform?page=${page + 1}`}>Next →</a>
              ) : (
                <span style="color: #9ca3af">Next →</span>
              )}
            </div>
          )}
        </>
      )}
    </Layout>
  );
}
