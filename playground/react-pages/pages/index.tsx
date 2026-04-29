import { Link } from '@void/react';
import type { Props } from './index.server.ts';

export default function HomePage({ title }: Props) {
  return (
    <div>
      <h1>Welcome — {title}</h1>
      <p>This is the React Pages playground.</p>
      <Link href="/users" prefetch="mount">
        Go to Users
      </Link>{' '}
      <Link href="/link-behavior">Link behavior</Link>{' '}
      <Link href="/action-error">Form behavior lab</Link>
    </div>
  );
}
