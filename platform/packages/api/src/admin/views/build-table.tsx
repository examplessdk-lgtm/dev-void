import { ACTIVE_BUILD_STATUSES } from '../../db.ts';
import type { Build } from '../../types.ts';
import { formatDateTime } from './format.ts';

const STATUS_SYMBOL: Record<Build['status'], string> = {
  queued: '○ queued',
  starting: '● starting',
  building: '● building',
  deploying: '● deploying',
  complete: '✓ complete',
  failed: '✗ failed',
  cancelled: '⊘ cancelled',
};

function isActive(status: Build['status']): boolean {
  return (ACTIVE_BUILD_STATUSES as ReadonlyArray<Build['status']>).includes(status);
}

function statusColor(status: Build['status']): string | undefined {
  switch (status) {
    case 'complete':
      return 'color: #16a34a; font-weight: 600';
    case 'failed':
    case 'cancelled':
      return 'color: #dc2626';
    case 'starting':
    case 'building':
    case 'deploying':
      return 'color: #ca8a04; font-weight: 600';
    default:
      return undefined;
  }
}

function duration(build: Build): string {
  if (!build.started_at) {
    return '-';
  }
  const start = new Date(
    build.started_at.endsWith('Z') ? build.started_at : build.started_at + 'Z',
  ).getTime();
  const end = build.completed_at
    ? new Date(
        build.completed_at.endsWith('Z') ? build.completed_at : build.completed_at + 'Z',
      ).getTime()
    : Date.now();
  if (isNaN(start) || isNaN(end) || end < start) {
    return '-';
  }
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function BuildTable({ builds, tz }: { builds: ReadonlyArray<Build>; tz?: string }) {
  if (builds.length === 0) {
    return (
      <p>
        <em>No builds.</em>
      </p>
    );
  }
  return (
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>Status</th>
          <th>Executor</th>
          <th>Instance</th>
          <th>Commit</th>
          <th>Branch</th>
          <th>Started</th>
          <th>Duration</th>
        </tr>
      </thead>
      <tbody>
        {builds.map((b) => {
          const active = isActive(b.status);
          return (
            <tr key={b.id} class={active ? 'build-active' : undefined}>
              <td>
                <a href={`/admin/builds/${b.id}`}>{b.id}</a>
              </td>
              <td style={statusColor(b.status)}>{STATUS_SYMBOL[b.status] ?? b.status}</td>
              <td>{b.executor}</td>
              <td>{b.instance_type ?? '-'}</td>
              <td>{b.commit_sha ? b.commit_sha.slice(0, 7) : '-'}</td>
              <td>{b.branch ?? '-'}</td>
              <td>{b.started_at ? formatDateTime(b.started_at, tz) : '-'}</td>
              <td>{duration(b)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
