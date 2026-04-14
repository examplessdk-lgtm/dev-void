import type { Props } from './about.server';

export default function AboutPage({ description }: Props) {
  return (
    <div>
      <h1 data-testid="about-title">About</h1>
      <p>{description}</p>
    </div>
  );
}
