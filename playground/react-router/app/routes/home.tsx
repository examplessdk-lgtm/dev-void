export default function HomePage() {
  return (
    <div style={{ padding: "16px" }}>
      <h1>React Router + Void</h1>
      <p>
        This playground demonstrates meta-framework integration. React Router handles routing and
        SSR, while Void provides bindings, migrations, and deployment.
      </p>
      <p>
        Visit <a href="/users">/users</a> to see D1 database access via a loader.
      </p>
    </div>
  );
}
