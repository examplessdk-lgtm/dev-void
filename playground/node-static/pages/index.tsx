import type { Props } from './index.server';

export default function HomePage({ title, runtime }: Props) {
  return (
    <div>
      <h1 data-testid="home-title">{title}</h1>
      <p data-testid="runtime">{runtime}</p>
      <p>This is a statically prerendered React app built with Node.js.</p>
    </div>
  );
}
