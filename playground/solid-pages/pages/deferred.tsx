import type { Props } from './deferred.server';

export default function DeferredPage(props: Props) {
  const stats = props.stats;
  if (stats.loading) {
    return (
      <div>
        <h1>{props.title}</h1>
        <div data-testid="deferred-loading">Loading stats...</div>
      </div>
    );
  }
  if (stats.error) {
    return (
      <div>
        <h1>{props.title}</h1>
        <div data-testid="deferred-error">Error: {stats.error.message}</div>
      </div>
    );
  }
  return (
    <div>
      <h1>{props.title}</h1>
      <div data-testid="deferred-resolved">Count: {stats.value.count}</div>
    </div>
  );
}
