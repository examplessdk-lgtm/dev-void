import { Suspense, use } from 'react';
import type { Props } from './deferred.server';

function Stats({ stats }: Pick<Props, 'stats'>) {
  const resolved = use(stats);

  return <div data-testid="deferred-resolved">Count: {resolved.count}</div>;
}

export default function DeferredPage({ title, stats }: Props) {
  return (
    <div>
      <h1>{title}</h1>
      <Suspense fallback={<div data-testid="deferred-loading">Loading stats...</div>}>
        <Stats stats={stats} />
      </Suspense>
    </div>
  );
}
