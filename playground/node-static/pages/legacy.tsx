import type { Props } from './legacy.server.ts';

export default function LegacyPage({ description }: Props) {
  return (
    <div>
      <h1 data-testid="legacy-title">Legacy</h1>
      <p>{description}</p>
    </div>
  );
}
