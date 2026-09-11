import type { PlanId } from '../../tiers.ts';
import { PLAN_LIMITS, getPlanLimits } from '../../tiers.ts';
import type { User, Project } from '../../types.ts';
import { formatLimit, formatNumber, formatBytes } from './format.ts';
import { Layout } from './layout.tsx';

type ProjectUsage = Readonly<{
  projectId: string;
  slug: string;
  requests: number;
  bandwidthBytes: number;
}>;

export function UserDetailPage({
  user,
  projects,
  deploysToday,
  usage,
  username,
}: {
  user: User;
  projects: ReadonlyArray<Project>;
  deploysToday: number;
  usage: {
    billingPeriodStart: string;
    totalRequests: number;
    totalBandwidth: number;
    projects: ReadonlyArray<ProjectUsage>;
  };
  username?: string;
}) {
  const plans = Object.keys(PLAN_LIMITS) as ReadonlyArray<PlanId>;
  const limits = getPlanLimits(user.plan);

  return (
    <Layout title={user.login} username={username}>
      <h1>{user.login}</h1>

      <table>
        <tbody>
          <tr>
            <th>ID</th>
            <td>{user.id}</td>
          </tr>
          <tr>
            <th>Provider</th>
            <td>{user.provider}</td>
          </tr>
          <tr>
            <th>Email</th>
            <td>{user.email ?? '-'}</td>
          </tr>
          <tr>
            <th>Role</th>
            <td>{user.role}</td>
          </tr>
          <tr>
            <th>Status</th>
            <td>{user.suspended_reason ? `suspended: ${user.suspended_reason}` : 'active'}</td>
          </tr>
          <tr>
            <th>Created</th>
            <td>{user.created_at}</td>
          </tr>
        </tbody>
      </table>

      <h2>Plan</h2>
      <form method="post" action={`/admin/users/${user.id}/plan`} style="margin-bottom: 10px">
        <select name="plan">
          {plans.map((p) => (
            <option key={p} value={p} selected={p === user.plan}>
              {p}
            </option>
          ))}
        </select>{' '}
        <button type="submit">Update</button>
      </form>
      <table>
        <thead>
          <tr>
            <th>Limit</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Requests / month</td>
            <td>{formatLimit(limits.requestsPerMonth)}</td>
          </tr>
          <tr>
            <td>CPU ms / request</td>
            <td>{formatLimit(limits.cpuMsPerRequest)}</td>
          </tr>
          <tr>
            <td>Sub-requests / invocation</td>
            <td>{formatLimit(limits.subRequestsPerInvocation)}</td>
          </tr>
          <tr>
            <td>Deploys / day</td>
            <td>
              {deploysToday} / {formatLimit(limits.deploysPerDay)}
            </td>
          </tr>
          <tr>
            <td>D1 storage</td>
            <td>{formatLimit(limits.d1StorageBytes, 'bytes')}</td>
          </tr>
          <tr>
            <td>R2 storage</td>
            <td>{formatLimit(limits.r2StorageBytes, 'bytes')}</td>
          </tr>
          <tr>
            <td>KV storage</td>
            <td>{formatLimit(limits.kvStorageBytes, 'bytes')}</td>
          </tr>
          <tr>
            <td>AI neurons / month</td>
            <td>{formatLimit(limits.aiNeuronsPerMonth)}</td>
          </tr>
          <tr>
            <td>Retained deployments</td>
            <td>{formatLimit(limits.retainedDeployments)}</td>
          </tr>
        </tbody>
      </table>

      <h2>Current Usage (since {new Date(usage.billingPeriodStart).toLocaleDateString()})</h2>
      <p>
        Requests: {formatNumber(usage.totalRequests)} / {formatLimit(limits.requestsPerMonth)}
      </p>
      <p>
        Deploys today: {formatNumber(deploysToday)} / {formatLimit(limits.deploysPerDay)}
      </p>
      <p>Bandwidth: {formatBytes(usage.totalBandwidth)}</p>
      {usage.projects.length > 1 && (
        <>
          <h3>Per Project</h3>
          <table>
            <thead>
              <tr>
                <th>Project</th>
                <th>Requests</th>
                <th>Bandwidth</th>
              </tr>
            </thead>
            <tbody>
              {usage.projects.map((p) => (
                <tr key={p.projectId}>
                  <td>
                    <a href={`/admin/projects/${p.projectId}`}>{p.slug}</a>
                  </td>
                  <td>{formatNumber(p.requests)}</td>
                  <td>{formatBytes(p.bandwidthBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h2>Suspension</h2>
      {user.suspended_reason ? (
        <form method="post" action={`/admin/users/${user.id}/unsuspend`}>
          <button type="submit">Unsuspend</button>
        </form>
      ) : (
        <form method="post" action={`/admin/users/${user.id}/suspend`}>
          <input type="text" name="reason" placeholder="Reason..." value="admin_suspended" />{' '}
          <button type="submit" class="danger">
            Suspend
          </button>
        </form>
      )}

      <h2>Projects ({projects.length})</h2>
      {projects.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Slug</th>
              <th>Type</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id}>
                <td>
                  <a href={`/admin/projects/${p.id}`}>{p.slug}</a>
                </td>
                <td>{p.type}</td>
                <td>{new Date(p.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>
          <em>No projects.</em>
        </p>
      )}

      <h2>Danger Zone</h2>
      <form
        method="post"
        action={`/admin/users/${user.id}/delete`}
        onsubmit={`return confirm('Permanently delete user "${user.login}" and all ${projects.length} project(s)? This cannot be undone.')`}
      >
        <button type="submit" class="danger">
          Delete User
        </button>
      </form>
    </Layout>
  );
}
