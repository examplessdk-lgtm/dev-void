import type { PlatformEvent } from '../../types.ts';
import { PLATFORM_WORKERS, type PlatformEnv } from '../platform-workers.ts';
import { formatDateTime, STATUS_COLORS } from './format.ts';
import { Layout } from './layout.tsx';

export function PlatformRollbackResultPage({
  events,
  batchId,
  env,
  username,
  tz,
}: {
  events: ReadonlyArray<PlatformEvent>;
  batchId: string;
  env: PlatformEnv;
  username: string;
  tz?: string;
}) {
  const allSuccess = events.every((e) => e.status === 'success');
  const anyFailed = events.some((e) => e.status === 'failed');

  return (
    <Layout title="Rollback Results" username={username}>
      <p style="margin-bottom: 16px">
        <a href={'/admin/platform'}>&larr; Back to Platform</a>
      </p>

      <h1>Batch Rollback Results</h1>

      <p style="margin-bottom: 8px; font-size: 0.85rem">
        Batch ID:{' '}
        <span class="copy-btn" data-copy={batchId} style="cursor: pointer">
          {batchId}
        </span>{' '}
        | Environment: <strong>{env}</strong>
        {events[0] && <> | Admin: {events[0].admin_login}</>}
        {events[0] && <> | {formatDateTime(events[0].created_at, tz)}</>}
      </p>

      {allSuccess ? (
        <div style="background: #dcfce7; border: 1px solid #16a34a; padding: 12px; margin-bottom: 16px; font-size: 0.85rem">
          <strong>All workers rolled back successfully.</strong>
        </div>
      ) : anyFailed ? (
        <div style="background: #fee2e2; border: 1px solid #dc2626; padding: 12px; margin-bottom: 16px; font-size: 0.85rem">
          <strong>Rollback failed.</strong> Some workers were not rolled back. Check the results
          below.
        </div>
      ) : (
        <div style="background: #fef3c7; border: 1px solid #f59e0b; padding: 12px; margin-bottom: 16px; font-size: 0.85rem">
          <strong>Rollback partially completed.</strong>
        </div>
      )}

      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Worker</th>
            <th>Script</th>
            <th>Version</th>
            <th>Status</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {[...events]
            .sort((a, b) => {
              const orderA =
                PLATFORM_WORKERS.find((w) => w.name === a.worker_name)?.deployOrder ?? 0;
              const orderB =
                PLATFORM_WORKERS.find((w) => w.name === b.worker_name)?.deployOrder ?? 0;
              return orderB - orderA;
            })
            .map((event, i) => (
              <tr key={event.id}>
                <td>{i + 1}</td>
                <td>{event.worker_name}</td>
                <td style="font-size: 0.75rem">{event.script_name}</td>
                <td>
                  <span class="copy-btn" data-copy={event.version_id} style="cursor: pointer">
                    {event.version_id.slice(0, 8)}...
                  </span>
                </td>
                <td>
                  <span style={`color: ${STATUS_COLORS[event.status] ?? '#000'}; font-weight: 600`}>
                    {event.status}
                  </span>
                </td>
                <td style="font-size: 0.75rem; color: #dc2626">{event.error_message ?? '—'}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </Layout>
  );
}
