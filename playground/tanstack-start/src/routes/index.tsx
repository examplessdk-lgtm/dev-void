import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

const getInfo = createServerFn().handler(() => {
  return {
    runtime: navigator.userAgent,
  };
});

export const Route = createFileRoute('/')({
  loader: () => getInfo(),
  component: HomePage,
});

function HomePage() {
  const data = Route.useLoaderData();

  return (
    <div style={{ padding: '16px' }}>
      <h1>TanStack Start + Void</h1>
      <p>
        This playground demonstrates meta-framework integration. TanStack Start handles routing and
        SSR, while Void provides bindings, migrations, and deployment.
      </p>
      <p>
        Runtime: <code>{data.runtime}</code>
      </p>
      <p>
        Visit <a href="/users">/users</a> to see D1 database access via a server function.
      </p>
    </div>
  );
}
