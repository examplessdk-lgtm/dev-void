import type { Props } from './legacy.server';

export default function LegacyPage({ description }: Props) {
  return (
    <div>
      <h1 data-testid="legacy-title">Legacy</h1>
      <p>{description}</p>
    </div>
  );
}
