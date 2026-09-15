import { Hono } from 'hono';
import {
  getAllDeploymentsWithProject,
  countDeployments,
  searchDeployments,
  getDeployment,
  getProject,
} from '../../db.ts';
import { type ApiEnv } from '../../env.ts';
import { OperatorError } from '../../operator/common.ts';
import {
  deploymentLogs,
  requestDeploymentCancellation,
} from '../../operator/deployment-operations.ts';
import type { DeployManifest } from '../../types.ts';
import { DeploymentLogs } from '../views/deployment-logs.tsx';
import { displayStatus } from '../views/deployment-table.tsx';
import { DeploymentsListPage } from '../views/deployments-list.tsx';
import { formatDateTime } from '../views/format.ts';
import { Layout } from '../views/layout.tsx';

const PAGE_SIZE = 20;
const app = new Hono<ApiEnv>();

const ACTIVE_DEPLOYMENT_STATUSES = new Set(['pending', 'uploading', 'migrating', 'prerendering']);

// GET /deployments
app.get('/', async (context) => {
  const search = context.req.query('search');
  const tz = (context.req.raw.cf?.timezone as string | undefined) ?? undefined;
  if (search) {
    const deployments = await searchDeployments(context.get('db'), search);
    return context.html(
      <DeploymentsListPage
        deployments={deployments}
        search={search}
        username={context.get('user').login}
        tz={tz}
      />,
    );
  }
  const page = Math.max(1, parseInt(context.req.query('page') ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const [deployments, total] = await Promise.all([
    getAllDeploymentsWithProject(context.get('db'), PAGE_SIZE, offset),
    countDeployments(context.get('db')),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return context.html(
    <DeploymentsListPage
      deployments={deployments}
      page={page}
      totalPages={totalPages}
      username={context.get('user').login}
      tz={tz}
    />,
  );
});

// GET /deployments/:id
app.get('/:id', async (context) => {
  const deployment = await getDeployment(context.get('db'), context.req.param('id'));
  if (!deployment) {
    return context.html('<h1>Deployment not found</h1>', 404);
  }
  const project = await getProject(context.get('db'), deployment.project_id);
  const tz = (context.req.raw.cf?.timezone as string | undefined) ?? undefined;
  const canCancel = ACTIVE_DEPLOYMENT_STATUSES.has(deployment.status);

  let manifest: DeployManifest | null = null;
  try {
    if (deployment.manifest) {
      manifest = JSON.parse(deployment.manifest) as DeployManifest;
    }
  } catch {
    // invalid JSON — skip manifest display
  }

  return context.html(
    <Layout title={`Deployment ${deployment.id}`} username={context.get('user').login}>
      <h1>Deployment {deployment.id}</h1>

      {canCancel && (
        <>
          <h2>Deploy Control</h2>
          <form
            method="post"
            action={`/admin/deployments/${deployment.id}/cancel`}
            onsubmit="return confirm('Cancel deployment &quot;' + this.dataset.deployment + '&quot;?')"
            data-deployment={deployment.id}
          >
            <button type="submit" class="danger">
              Cancel Deploy
            </button>
          </form>
        </>
      )}

      {(deployment.status === 'failed' || deployment.status === 'canceled') &&
        deployment.error_message && (
          <>
            <h2>Error</h2>
            <pre>{deployment.error_message}</pre>
            <p>
              <button type="button" class="copy-btn" data-copy={deployment.error_message}>
                Copy error
              </button>
            </p>
          </>
        )}

      <table>
        <tbody>
          <tr>
            <th>ID</th>
            <td>{deployment.id}</td>
            <th>Project</th>
            <td>
              {project ? (
                <a href={`/admin/projects/${project.id}`}>{project.slug}</a>
              ) : (
                deployment.project_id
              )}
            </td>
          </tr>
          <tr>
            <th>Status</th>
            <td
              style={(() => {
                const s = displayStatus(deployment, project?.active_deployment_id);
                if (s === 'live') {
                  return 'color: #16a34a; font-weight: 600';
                }
                if (s === 'retained') {
                  return 'color: #16a34a';
                }
                if (s === 'evicted') {
                  return 'color: #888';
                }
                if (s === 'failed') {
                  return 'color: #dc2626';
                }
                return undefined;
              })()}
            >
              {displayStatus(deployment, project?.active_deployment_id)}
            </td>
            <th>Source</th>
            <td>{deployment.source ?? '-'}</td>
          </tr>
          <tr>
            <th>Commit</th>
            <td>{deployment.commit ?? '-'}</td>
            <th>Created</th>
            <td>{formatDateTime(deployment.created_at, tz)}</td>
          </tr>
          <tr>
            <th>Deployed</th>
            <td>{deployment.deployed_at ? formatDateTime(deployment.deployed_at, tz) : '-'}</td>
            <th>Type</th>
            <td>{project?.type ?? '-'}</td>
          </tr>
          <tr>
            <th>CLI Version</th>
            <td>{deployment.cli_version ?? '-'}</td>
            <th />
            <td />
          </tr>
          {manifest && (
            <tr>
              <td colspan={4} style="padding: 0">
                <details>
                  <summary style="padding: 8px; cursor: pointer; font-weight: 600">
                    Manifest
                  </summary>
                  <div style="padding: 0 8px 8px">
                    <table style="margin: 0">
                      <tbody>
                        {manifest.bindings &&
                          Object.entries(manifest.bindings).map(([type, value]) =>
                            Array.isArray(value) && value.length > 0 ? (
                              <tr key={type}>
                                <th>{type.toUpperCase()}</th>
                                <td>
                                  {value.map((n: string, i: number) => (
                                    <span key={n}>
                                      {i > 0 && ', '}
                                      <code>{n}</code>
                                    </span>
                                  ))}
                                </td>
                              </tr>
                            ) : value === true ? (
                              <tr key={type}>
                                <th>{type.toUpperCase()}</th>
                                <td>enabled</td>
                              </tr>
                            ) : null,
                          )}
                        {manifest.migrations && (
                          <tr>
                            <th>Migrations</th>
                            <td>
                              {manifest.migrations.dialect} — {manifest.migrations.pending} pending
                            </td>
                          </tr>
                        )}
                        {manifest.schedules && manifest.schedules.length > 0 && (
                          <tr>
                            <th>Schedules</th>
                            <td>
                              {manifest.schedules.map((s, i) => (
                                <span key={s.name}>
                                  {i > 0 && ', '}
                                  {s.name}: {s.cron}
                                </span>
                              ))}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                    {deployment.manifest && (
                      <details style="margin-top: 8px">
                        <summary style="cursor: pointer; font-size: 0.85rem">Raw JSON</summary>
                        <pre style="margin-top: 8px; font-size: 0.8rem">
                          {JSON.stringify(JSON.parse(deployment.manifest), null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                </details>
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {deployment.status === 'live' && project && <DeploymentLogs deploymentId={deployment.id} />}
    </Layout>,
  );
});

// POST /deployments/:id/cancel
app.post('/:id/cancel', async (context) => {
  const deployment = await getDeployment(context.get('db'), context.req.param('id'));
  if (!deployment) {
    return context.html('<h1>Deployment not found</h1>', 404);
  }

  try {
    await requestDeploymentCancellation(context.get('db'), deployment.id);
  } catch (error) {
    if (error instanceof OperatorError) {
      return context.text(error.message, error.status);
    }
    throw error;
  }
  return context.redirect(`/admin/deployments/${deployment.id}`);
});

// GET /deployments/:id/logs — shared historical log reader.
app.get('/:id/logs', async (context) => {
  try {
    return context.json(
      await deploymentLogs(context.get('db'), context.env, context.req.param('id'), {
        since: context.req.query('since'),
        limit: Number(context.req.query('limit') ?? 100),
        cursor: context.req.query('cursor'),
        order: 'newest-first',
      }),
    );
  } catch (error) {
    if (error instanceof OperatorError) {
      return context.json({ error: error.message }, error.status);
    }
    throw error;
  }
});

export default app;
