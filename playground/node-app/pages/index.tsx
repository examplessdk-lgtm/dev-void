import type { Props } from './index.server.ts';

export default function HomePage({ title }: Props) {
  return (
    <div>
      <h1 data-testid="title">Welcome — {title}</h1>
      <p>This is a React Pages app running on Node.js.</p>
    </div>
  );
}
