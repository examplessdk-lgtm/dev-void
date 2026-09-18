import { Hono } from 'hono';
import { SITE_DOMAIN } from '../../constants.ts';
import { getAllProjectsWithOwner, countProjects, searchProjects } from '../../db.ts';
import type { ApiEnv } from '../../env.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import { OperatorError } from '../../operator/common.ts';
import {
  deleteOperatorProject,
  getOperatorProject,
  previewOperatorProjectOwner,
  transferOperatorProjectOwner,
} from '../../operator/tenant-service.ts';
import { projectUrl, projectWithUrl } from '../../project-url.ts';
import { renderOperationError } from '../operation-error.tsx';
import { BuildTable } from '../views/build-table.tsx';
import { DeploymentTable } from '../views/deployment-table.tsx';
import { Layout } from '../views/layout.tsx';
import { ProjectsListPage } from '../views/projects-list.tsx';

const PAGE_SIZE = 20;
const app = new Hono<ApiEnv>();
app.onError(renderOperationError);

function transferTarget(body: Record<string, string | File>) {
  const value = body.userId;
  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    throw new OperatorError(400, 'New owner user ID is required.');
  }
  return value.trim();
}

function suspensionLabel(owner: { suspended: boolean; suspendedReason: string | null }) {
  return owner.suspended ? `Suspended (${owner.suspendedReason ?? 'unknown reason'})` : 'Active';
}

// GET /projects
app.get('/', async (context) => {
  const search = context.req.query('search');
  const siteDomain = context.env.SITE_DOMAIN ?? SITE_DOMAIN;
  if (search) {
    const projects = await searchProjects(context.get('db'), search);
    return context.html(
      <ProjectsListPage
        projects={projects.map((project) => projectWithUrl(project, context.env))}
        search={search}
        siteDomain={siteDomain}
        username={context.get('user').login}
      />,
    );
  }
  const page = Math.max(1, parseInt(context.req.query('page') ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const [projects, total] = await Promise.all([
    getAllProjectsWithOwner(context.get('db'), PAGE_SIZE, offset),
    countProjects(context.get('db')),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return context.html(
    <ProjectsListPage
      projects={projects.map((project) => projectWithUrl(project, context.env))}
      page={page}
      totalPages={totalPages}
      siteDomain={siteDomain}
      username={context.get('user').login}
    />,
  );
});

// GET /projects/:id
app.get('/:id', async (context) => {
  const { project, deployments, resources, owner, domains, builds } = await getOperatorProject(
    context.get('db'),
    context.req.param('id'),
  );

  const cfAccountId = context.env.CF_ACCOUNT_ID;
  const deployUrl = projectUrl(project, context.env);
  const tz = (context.req.raw.cf?.timezone as string | undefined) ?? undefined;

  return context.html(
    <Layout title={project.slug} username={context.get('user').login}>
      <h1>{project.slug}</h1>

      <table>
        <tbody>
          <tr>
            <th>ID</th>
            <td>{project.id}</td>
          </tr>
          <tr>
            <th>Slug</th>
            <td>{project.slug}</td>
          </tr>
          <tr>
            <th>URL</th>
            <td>
              <a href={deployUrl} target="_blank" rel="noopener noreferrer">
                {deployUrl}
              </a>
            </td>
          </tr>
          <tr>
            <th>Custom Domain</th>
            <td>
              {domains.length > 0 ? (
                domains.map((d) => (
                  <span key={d.id}>
                    <a href={`https://${d.hostname}`} target="_blank" rel="noopener noreferrer">
                      {d.hostname}
                    </a>{' '}
                    ({d.status}){' '}
                  </span>
                ))
              ) : (
                <>None</>
              )}
            </td>
          </tr>
          <tr>
            <th>Owner</th>
            <td>
              {owner ? <a href={`/admin/users/${owner.id}`}>{owner.login}</a> : project.user_id}
            </td>
          </tr>
          <tr>
            <th>Type</th>
            <td>{project.type}</td>
          </tr>
          <tr>
            <th>Email</th>
            <td>
              <a href={`/admin/email/${project.id}`}>usage, limits, destinations</a>
            </td>
          </tr>
          <tr>
            <th>Created</th>
            <td>{project.created_at}</td>
          </tr>
        </tbody>
      </table>

      <h2>Resources ({resources.length})</h2>
      {resources.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Binding</th>
              <th>CF ID</th>
            </tr>
          </thead>
          <tbody>
            {resources.map((r) => (
              <tr key={r.id}>
                <td>{r.type}</td>
                <td>{r.binding_name}</td>
                <td>
                  {cfAccountId && (r.type === 'd1' || r.type === 'kv' || r.type === 'r2') ? (
                    <a
                      href={
                        r.type === 'd1'
                          ? `https://dash.cloudflare.com/${cfAccountId}/workers/d1/databases/${r.cf_id}/metrics`
                          : r.type === 'kv'
                            ? `https://dash.cloudflare.com/${cfAccountId}/workers/kv/namespaces/${r.cf_id}/metrics`
                            : `https://dash.cloudflare.com/${cfAccountId}/r2/default/buckets/${r.cf_id}`
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {r.cf_id}
                    </a>
                  ) : (
                    r.cf_id
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>
          <em>No resources provisioned.</em>
        </p>
      )}

      <h2>Recent Deployments ({deployments.length})</h2>
      <DeploymentTable
        deployments={deployments}
        activeDeploymentId={project.active_deployment_id}
        tz={tz}
      />

      <h2>Builds ({builds.length})</h2>
      <BuildTable builds={builds} tz={tz} />

      <h2>Transfer Ownership</h2>
      <p>
        Transfer this project to an existing Void Platform user. You will review the ownership,
        plan, suspension, active-work, routing, and usage-counter changes before applying them.
      </p>
      <form method="post" action={`/admin/projects/${project.id}/owner/preview`}>
        <label>
          New owner user ID
          <input type="text" name="userId" required maxlength={512} placeholder="user_..." />
        </label>{' '}
        <button type="submit">Preview Transfer</button>
      </form>

      <h2>Danger Zone</h2>
      <form
        method="post"
        action={`/admin/projects/${project.id}/delete`}
        onsubmit="return confirm('Permanently delete project &quot;' + this.dataset.slug + '&quot; and all its resources? This cannot be undone.')"
        data-slug={project.slug}
      >
        <button type="submit" class="danger">
          Delete Project
        </button>
      </form>
    </Layout>,
  );
});

// POST /projects/:id/owner/preview
app.post('/:id/owner/preview', async (context) => {
  const projectId = context.req.param('id');
  const body = await context.req.parseBody();
  const userId = transferTarget(body);
  const result = await previewOperatorProjectOwner(context, projectId, userId);
  const convergenceOnly = !result.changed;
  const operationBlocked = result.blockers.some(
    (blocker) => !convergenceOnly || blocker.kind === 'deletion',
  );

  return context.html(
    <Layout
      title={`${convergenceOnly ? 'Converge' : 'Transfer'} ${result.target.slug}`}
      username={context.get('user').login}
    >
      <h1>
        {convergenceOnly ? 'Converge Ownership State' : 'Transfer Ownership'}: {result.target.slug}
      </h1>
      <table>
        <thead>
          <tr>
            <th>Account</th>
            <th>User</th>
            <th>Plan</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>Current owner</th>
            <td>
              {result.currentOwner.login} (<code>{result.currentOwner.id}</code>)
            </td>
            <td>{result.currentOwner.plan}</td>
            <td>{suspensionLabel(result.currentOwner)}</td>
          </tr>
          <tr>
            <th>New owner</th>
            <td>
              {result.newOwner.login} (<code>{result.newOwner.id}</code>)
            </td>
            <td>{result.newOwner.plan}</td>
            <td>{suspensionLabel(result.newOwner)}</td>
          </tr>
        </tbody>
      </table>

      {convergenceOnly ? (
        <p>
          This project is already owned by the target. This is a convergence-only operation:
          applying it repairs membership, usage-counter, routing, and account metadata without
          changing ownership. The owner's stored project role is{' '}
          <strong>{result.targetPreviousRole ?? 'none'}</strong>. Usage transfer is{' '}
          {result.usageTransfer}.
        </p>
      ) : (
        <p>
          The former owner will become a <strong>{result.formerOwnerRole}</strong>. The target's
          current project role is <strong>{result.targetPreviousRole ?? 'none'}</strong>. Usage
          transfer is {result.usageTransfer}.
        </p>
      )}

      <h2>Operation blockers</h2>
      {result.blockers.length > 0 ? (
        <>
          <ul>
            {result.blockers.map((blocker) => (
              <li key={`${blocker.kind}:${blocker.id}`}>
                {blocker.kind}: {blocker.id} ({blocker.status})
              </li>
            ))}
          </ul>
          {convergenceOnly && !operationBlocked ? (
            <p>Active work does not block convergence.</p>
          ) : null}
        </>
      ) : (
        <p>None.</p>
      )}

      <h2>Convergence</h2>
      <p>
        {result.counterUpdates.detachUserId ? (
          <>
            Usage counters: detach from <code>{result.counterUpdates.detachUserId}</code>, attach to{' '}
            <code>{result.counterUpdates.attachUserId}</code>.
          </>
        ) : (
          <>
            Usage counters: attach or reconcile with{' '}
            <code>{result.counterUpdates.attachUserId}</code>; no former-owner detachment is needed.
          </>
        )}
      </p>
      <p>Routing and account entries: {result.routingUpdates.join(', ')}</p>

      <h2>GitHub authorization provenance</h2>
      {result.github ? (
        <p>
          {result.github.repository} installation {result.github.installationId}, authorized by{' '}
          {result.github.authorizedByUserId ?? 'unknown'} ({result.github.executor}).
        </p>
      ) : (
        <p>No GitHub connection.</p>
      )}

      {!operationBlocked ? (
        <form method="post" action={`/admin/projects/${projectId}/owner`}>
          <input type="hidden" name="userId" value={userId} />
          <button type="submit" class="danger">
            {convergenceOnly ? 'Apply Convergence' : 'Apply Ownership Transfer'}
          </button>
        </form>
      ) : (
        <p>
          {convergenceOnly
            ? 'Project deletion blocks convergence.'
            : 'Resolve or cancel all active work before applying this transfer.'}
        </p>
      )}
      <p>
        <a href={`/admin/projects/${projectId}`}>Back to project</a>
      </p>
    </Layout>,
  );
});

// POST /projects/:id/owner
app.post('/:id/owner', async (context) => {
  const projectId = context.req.param('id');
  const body = await context.req.parseBody();
  const userId = transferTarget(body);
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`projects/${projectId}/owner`, { userId }),
    async () => {
      await transferOperatorProjectOwner(context, projectId, userId);
      return { response: context.redirect(`/admin/projects/${projectId}`), succeeded: true };
    },
  );
});

// POST /projects/:id/delete
app.post('/:id/delete', async (context) => {
  const projectId = context.req.param('id');
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`projects/${projectId}/delete`),
    async () => {
      await deleteOperatorProject(context, projectId);
      return { response: context.redirect('/admin/projects'), succeeded: true };
    },
  );
});

export default app;
