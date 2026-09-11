import type { Project } from '../../types.ts';

export type ProjectRow = Project & {
  owner_login: string | null;
  last_deploy: string | null;
  last_deploy_id: string | null;
  last_deploy_status: string | null;
};

export function ProjectsTable({
  projects,
  siteDomain,
}: {
  projects: ReadonlyArray<ProjectRow>;
  siteDomain: string;
}) {
  return (
    <>
      <table>
        <thead>
          <tr>
            <th>Slug</th>
            <th>URL</th>
            <th>Owner</th>
            <th>Type</th>
            <th>Created</th>
            <th>Last Deploy</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p.id}>
              <td>
                <a href={`/admin/projects/${p.id}`}>{p.slug}</a>
              </td>
              <td>
                <a
                  href={`https://${p.slug}.${siteDomain}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {p.slug}.{siteDomain}
                </a>
              </td>
              <td>
                {p.owner_login ? <a href={`/admin/users/${p.user_id}`}>{p.owner_login}</a> : '-'}
              </td>
              <td>{p.type}</td>
              <td>{new Date(p.created_at).toLocaleDateString()}</td>
              <td>
                {p.last_deploy ? (
                  <>
                    <span
                      style={`display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:10px;vertical-align:middle;background:${p.last_deploy_status === 'failed' ? '#dc2626' : '#16a34a'}`}
                    />
                    {p.last_deploy_id ? (
                      <a href={`/admin/deployments/${p.last_deploy_id}`}>
                        {new Date(p.last_deploy).toLocaleString()}
                      </a>
                    ) : (
                      new Date(p.last_deploy).toLocaleString()
                    )}
                  </>
                ) : (
                  '-'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {projects.length === 0 && (
        <p>
          <em>No projects found.</em>
        </p>
      )}
    </>
  );
}
