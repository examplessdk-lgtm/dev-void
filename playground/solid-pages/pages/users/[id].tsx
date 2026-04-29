import { Link } from '@void/solid';
import type { Props } from './[id].server.ts';

export default function UserDetailPage(props: Props) {
  return (
    <div>
      <h1>{props.user.name}</h1>
      <p>Email: {props.user.email}</p>
      <Link href="/users" prefetch>
        &larr; Back to Users
      </Link>
    </div>
  );
}
