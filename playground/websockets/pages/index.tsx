import { Link } from '@void/react';
import type { Props } from './index.server.ts';

export default function HomePage({ highlights }: Props) {
  return (
    <div>
      <h1>WebSocket Playground</h1>
      <p>
        Two focused demos for the new <code>void/ws</code> surface.
      </p>
      <ul>
        {highlights.map((item) => (
          <li key={item.href}>
            <Link href={item.href}>{item.title}</Link> - {item.body}
          </li>
        ))}
      </ul>
    </div>
  );
}
