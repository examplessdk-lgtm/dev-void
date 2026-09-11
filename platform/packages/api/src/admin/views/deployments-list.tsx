import type { Deployment } from '../../types.ts';
import { DeploymentTable } from './deployment-table.tsx';
import { Layout } from './layout.tsx';
import { Pagination } from './pagination.tsx';

export function DeploymentsListPage({
  deployments,
  search,
  page,
  totalPages,
  username,
  tz,
}: {
  deployments: ReadonlyArray<Deployment & { project_slug: string | null }>;
  search?: string;
  page?: number;
  totalPages?: number;
  username?: string;
  tz?: string;
}) {
  return (
    <Layout title="Deployments" username={username}>
      <h1>Deployments</h1>
      <form method="get" action="/admin/deployments" style="margin-bottom: 10px">
        <input
          type="text"
          name="search"
          placeholder="Search deployments..."
          value={search ?? ''}
          id="search-input"
        />{' '}
        <button type="submit">Search</button>
        {search && (
          <>
            {' '}
            | <a href="/admin/deployments">Clear</a>
          </>
        )}
      </form>
      <DeploymentTable deployments={deployments} showProject tz={tz} />
      {page != null && totalPages != null && (
        <Pagination page={page} totalPages={totalPages} baseUrl="/admin/deployments" />
      )}
      <script
        dangerouslySetInnerHTML={{
          __html: `
        (function() {
          var input = document.getElementById('search-input');
          var rows = document.querySelectorAll('table tbody tr');
          input.addEventListener('input', function() {
            var query = this.value.toLowerCase();
            rows.forEach(function(row) {
              row.style.display = row.textContent.toLowerCase().includes(query) ? '' : 'none';
            });
          });
        })();
      `,
        }}
      />
    </Layout>
  );
}
