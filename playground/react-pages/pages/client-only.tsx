import type { Props } from './client-only.server.ts';

export default function ClientOnlyPage(props: Props) {
  if (typeof window === 'undefined') {
    throw new Error('client-only page component rendered on the server');
  }

  return (
    <main>
      <h1>Client-only Page</h1>
      <p data-testid="client-only-title">{props.title}</p>
      <p data-testid="client-only-marker">{props.marker}</p>
    </main>
  );
}
