import { Link } from '@void/react';
import type { Props } from './[id].server.ts';

export default function UserDetailPage({ user }: Props) {
  return (
    <div>
      <h1>{user.name}</h1>
      <p>Email: {user.email}</p>
      <Link href="/users" prefetch>
        &larr; Back to Users
      </Link>
    </div>
  );
}
