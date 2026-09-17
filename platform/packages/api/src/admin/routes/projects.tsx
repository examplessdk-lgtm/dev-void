import { Hono } from 'hono';
import { SITE_DOMAIN } from '../../constants.ts';
import { getAllProjectsWithOwner, countProjects, searchProjects } from '../../db.ts';
import type { ApiEnv } from '../../env.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import { deleteOperatorProject, getOperatorProject } from '../../operator/tenant-service.ts';
import { projectUrl, projectWithUrl } from '../../project-url.ts';
import { renderOperationError } from '../operation-error.tsx';
import { BuildTable } from '../views/build-table.tsx';
import { DeploymentTable } from '../views/deployment-table.tsx';
import { Layout } from '../views/layout.tsx';
import { ProjectsListPage } from '../views/projects-list.tsx';

const PAGE_SIZE = 20;
const app = new Hono<ApiEnv>();
app.onError(renderOperationError);

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
