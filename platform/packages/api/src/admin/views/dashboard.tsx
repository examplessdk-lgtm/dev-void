import type { Deployment } from '../../types.ts';
import { DeploymentTable } from './deployment-table.tsx';
import { Layout } from './layout.tsx';
import type { ProjectRow } from './projects-table.tsx';
import { ProjectsTable } from './projects-table.tsx';

export type TopProjectRow = Readonly<{
  id: string;
  user_id: string;
  slug: string;
  type: string;
  owner_login: string | null;
  requests: number;
  bandwidthBytes: number;
  lastSeen: string;
}>;

type DashboardProps = Readonly<{
  stats: {
    users: number;
    projects: number;
    deployments: number;
  };
  projects: ReadonlyArray<ProjectRow>;
  deployments: ReadonlyArray<Deployment & { project_slug: string | null }>;
  topProjects: ReadonlyArray<TopProjectRow>;
  siteDomain: string;
  username?: string;
}>;

function formatNumber(value: number) {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = -1;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function HealthStatusBanner() {
  return (
    <div id="health-status" style="margin-bottom: 20px; padding: 12px; border: 1px solid #ccc">
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px">
        <strong>System Status</strong>
        <span id="health-summary" style="font-size: 0.8rem; color: #666">
          Loading...
        </span>
      </div>
      <div id="health-checks" style="display: flex; gap: 16px; flex-wrap: wrap" />
      <script
        dangerouslySetInnerHTML={{
          __html: `
(function(){
  function render(data){
    var el=document.getElementById('health-checks');
    var summary=document.getElementById('health-summary');
    var container=document.getElementById('health-status');
    if(!el||!summary||!container)return;
    el.innerHTML=data.checks.map(function(ch){
      var dot=ch.ok?'\\u25CF':'\\u25CF';
      var color=ch.ok?'#22c55e':'#ef4444';
      var ms=ch.latencyMs>0?' ('+ch.latencyMs+'ms)':'';
      return '<span style="font-size:0.8rem"><span style="color:'+color+'">'+dot+'</span> '+ch.name+ms+'</span>';
    }).join('');
    if(data.allOk){
      summary.textContent='All systems operational';
      summary.style.color='#22c55e';
      container.style.borderColor='#ccc';
    }else{
      var bad=data.checks.filter(function(ch){return!ch.ok}).length;
      summary.textContent=bad+' service'+(bad>1?'s':'')+' degraded';
      summary.style.color='#ef4444';
      container.style.borderColor='#ef4444';
    }
  }
  function poll(){
    fetch('/admin/health',{credentials:'same-origin'}).then(function(r){return r.json()}).then(render).catch(function(){});
  }
  poll();
  setInterval(poll,30000);
})();
`,
        }}
      />
    </div>
  );
}

function TopProjectsWidget({
  projects,
  siteDomain,
}: {
  projects: ReadonlyArray<TopProjectRow>;
  siteDomain: string;
}) {
  return (
    <div style="margin-top: 24px; padding: 12px; border: 1px solid #ccc">
      <div style="display: flex; align-items: baseline; justify-content: space-between; gap: 12px">
        <strong>Top 10 Projects</strong>
        <span style="font-size: 0.8rem; color: #666">
          Last hour, site traffic only (static / ssr / isr)
        </span>
      </div>
      {projects.length > 0 ? (
        <table style="margin-top: 10px">
          <thead>
            <tr>
              <th>#</th>
              <th>Project</th>
              <th>Owner</th>
              <th>Requests</th>
              <th>Bandwidth</th>
              <th>Last Seen</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((project, index) => (
              <tr key={project.id}>
                <td>{index + 1}</td>
                <td>
                  <div>
                    <a href={`/admin/projects/${project.id}`}>{project.slug}</a>
                  </div>
                  <div style="font-size: 0.75rem; color: #666">
                    <a
                      href={`https://${project.slug}.${siteDomain}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {project.slug}.{siteDomain}
                    </a>{' '}
                    · {project.type}
                  </div>
                </td>
                <td>
                  {project.owner_login ? (
                    <a href={`/admin/users/${project.user_id}`}>{project.owner_login}</a>
                  ) : (
                    '-'
                  )}
                </td>
                <td>{formatNumber(project.requests)}</td>
                <td>{formatBytes(project.bandwidthBytes)}</td>
                <td>{new Date(project.lastSeen).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p style="margin-top: 10px; color: #666">No recent project traffic in the last hour.</p>
      )}
    </div>
  );
}

export function DashboardPage({
  stats,
  projects,
  deployments,
  topProjects,
  siteDomain,
  username,
}: DashboardProps) {
  return (
    <Layout title="Dashboard" username={username}>
      <h1>Dashboard</h1>
      <HealthStatusBanner />
      <div style="display: flex; gap: 12px">
        <a
          href="/admin/users"
          style="flex: 1; text-align: center; padding: 16px; border: 1px solid #ccc; text-decoration: none; color: inherit"
        >
          <div style="font-size: 1.5rem; font-weight: 700">{stats.users}</div>
          <div>users</div>
        </a>
        <a
          href="/admin/projects"
          style="flex: 1; text-align: center; padding: 16px; border: 1px solid #ccc; text-decoration: none; color: inherit"
        >
          <div style="font-size: 1.5rem; font-weight: 700">{stats.projects}</div>
          <div>projects</div>
        </a>
        <a
          href="/admin/deployments"
          style="flex: 1; text-align: center; padding: 16px; border: 1px solid #ccc; text-decoration: none; color: inherit"
        >
          <div style="font-size: 1.5rem; font-weight: 700">{stats.deployments}</div>
          <div>deployments</div>
        </a>
      </div>
      <TopProjectsWidget projects={topProjects} siteDomain={siteDomain} />

      <h2>Latest Projects</h2>
      <ProjectsTable projects={projects} siteDomain={siteDomain} />

      <h2>Latest Deployments</h2>
      <DeploymentTable deployments={deployments} showProject />
    </Layout>
  );
}
