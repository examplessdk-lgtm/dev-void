import { Link, useForm } from '@void/react';
import { useFormStatus } from 'react-dom';
import type { Props } from './index.server.ts';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? 'Saving...' : 'Add User'}
    </button>
  );
}

export default function UsersPage({ users }: Props) {
  const form = useForm('/users', {
    name: '',
    email: '',
  });

  return (
    <div>
      <h1>Users</h1>

      <ul>
        {users.map((user) => (
          <li key={user.id}>
            <Link href={`/users/${user.id}`} prefetch="visible">
              {user.name}
            </Link>{' '}
            ({user.email})
          </li>
        ))}
      </ul>

      <h2>Add User</h2>
      <form action={form.post}>
        <div>
          <label>Name:</label>
          <input
            name="name"
            value={form.data.name}
            onChange={(e) => form.setData('name', e.target.value)}
          />
          {form.errors.name && <span style={{ color: 'red' }}>{form.errors.name}</span>}
        </div>
        <div>
          <label>Email:</label>
          <input
            name="email"
            value={form.data.email}
            onChange={(e) => form.setData('email', e.target.value)}
          />
          {form.errors.email && <span style={{ color: 'red' }}>{form.errors.email}</span>}
        </div>
        <SubmitButton />
      </form>
    </div>
  );
}
