import { Hono } from 'hono';
import { buildManagerNamespace } from '../../build-namespace.ts';
import { getBuild } from '../../db.ts';
import type { ApiEnv } from '../../env.ts';
import { BuildLogs, isTerminalBuildStatus } from '../views/build-logs.tsx';
import { formatDateTime } from '../views/format.ts';
import { Layout } from '../views/layout.tsx';

const app = new Hono<ApiEnv>();

// GET /admin/builds/:id/logs?since=N
//
// Backs the live-tail poller in the admin build page. Reads the build row for
// its `executor` + `instance_type`, then:
//   - container builds: front the BuildManager DO's READ-ONLY `GET /logs?since=N`
//     (the DO that ran the build, chosen by `instance_type` via
//     `buildManagerNamespace` — free → BUILD_MANAGER, `standard-4` →
//     BUILD_MANAGER_LARGE). Relays the DO's `{ lines, lastSeq }` JSON verbatim.
//   - non-container (github_actions) builds: there is no DO log store; return an
//     empty page plus the external `logs_url` so the UI can link out. No DO call.
app.get('/:id/logs', async (context) => {
  const build = await getBuild(context.get('db'), context.req.param('id'));
  if (!build) {
    return context.json({ error: 'build not found' }, 404);
  }

  // A missing/non-numeric `since` polls from the start. Matches the DO's own
  // `handleReadLogs` guard so the cursor never moves backward.
  const raw = Number(context.req.query('since'));
  const since = Number.isFinite(raw) ? raw : 0;

  if (build.executor !== 'container') {
    return context.json({ lines: [], lastSeq: 0, external: build.logs_url ?? null });
  }

  const ns = buildManagerNamespace(context.env, build.instance_type);
  const stub = ns.get(ns.idFromName(build.id));
  const res = await stub.fetch(`http://manager/logs?since=${since}`);
  const body = (await res.json()) as { lines: ReadonlyArray<unknown>; lastSeq: number };
  return context.json(body);
});

// GET /admin/builds/:id
//
// Build detail page: metadata + (for container builds) a live log panel whose
// inline poller hits the `/logs` endpoint above. github_actions builds get a
// link out to their GitHub Actions run instead, since their logs live there.
//
// `?status=1` returns a tiny JSON `{ status, terminal }` probe used by the
// log-panel poller to decide when to stop polling — it does NOT touch the DO
// or the Task-3 logs endpoint.
app.get('/:id', async (context) => {
  const build = await getBuild(context.get('db'), context.req.param('id'));
  if (!build) {
    if (context.req.query('status') !== undefined) {
      return context.json({ error: 'build not found' }, 404);
    }
    return context.html('<h1>Build not found</h1>', 404);
  }

  if (context.req.query('status') !== undefined) {
    return context.json({ status: build.status, terminal: isTerminalBuildStatus(build.status) });
  }

  const tz = (context.req.raw.cf?.timezone as string | undefined) ?? undefined;

  return context.html(
    <Layout title={`Build ${build.id}`} username={context.get('user').login}>
      <h1>Build {build.id}</h1>

      <table>
        <tbody>
          <tr>
            <th>Status</th>
            <td>{build.status}</td>
          </tr>
          <tr>
            <th>Project</th>
            <td>
              <a href={`/admin/projects/${build.project_id}`}>{build.project_id}</a>
            </td>
          </tr>
          <tr>
            <th>Executor</th>
            <td>{build.executor}</td>
          </tr>
          <tr>
            <th>Instance Type</th>
            <td>{build.instance_type ?? '-'}</td>
          </tr>
          <tr>
            <th>Commit</th>
            <td>{build.commit_sha ? build.commit_sha.slice(0, 7) : '-'}</td>
          </tr>
          <tr>
            <th>Branch</th>
            <td>{build.branch ?? '-'}</td>
          </tr>
          <tr>
            <th>Deployment</th>
            <td>
              {build.deployment_id ? (
                <a href={`/admin/deployments/${build.deployment_id}`}>{build.deployment_id}</a>
              ) : (
                '-'
              )}
            </td>
          </tr>
          {build.error ? (
            <tr>
              <th>Error</th>
              <td>
                <span style="color: red; max-width: 600px; display: inline-block; word-break: break-word">
                  {build.error}
                </span>
              </td>
            </tr>
          ) : null}
          <tr>
            <th>Exit Code</th>
            <td>{build.exit_code ?? '-'}</td>
          </tr>
          <tr>
            <th>Started</th>
            <td>{build.started_at ? formatDateTime(build.started_at, tz) : '-'}</td>
          </tr>
          <tr>
            <th>Completed</th>
            <td>{build.completed_at ? formatDateTime(build.completed_at, tz) : '-'}</td>
          </tr>
          <tr>
            <th>Created</th>
            <td>{formatDateTime(build.created_at, tz)}</td>
          </tr>
        </tbody>
      </table>

      {build.executor === 'container' ? (
        <BuildLogs build={build} />
      ) : (
        <>
          <h2>Build Logs</h2>
          {build.logs_url ? (
            <p>
              <a href={build.logs_url} target="_blank" rel="noopener noreferrer">
                View logs on GitHub ↗
              </a>
            </p>
          ) : (
            <p>
              <em>No external logs available.</em>
            </p>
          )}
        </>
      )}
    </Layout>,
  );
});

export default app;
