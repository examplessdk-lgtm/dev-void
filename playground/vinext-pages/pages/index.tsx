export async function getServerSideProps() {
  return { props: {} };
}

export default function Home() {
  return (
    <div style={{ padding: '16px' }}>
      <h1>vinext Pages Router + Void</h1>
      <p>This playground demonstrates vinext Pages Router integration with Void.</p>
      <p>
        Visit <a href="/smoke">/smoke</a> to see D1 and KV access via getServerSideProps.
      </p>
    </div>
  );
}
