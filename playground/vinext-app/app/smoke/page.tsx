import { users } from '@schema';
import { db } from 'void/db';
import { kv } from 'void/kv';

export default async function SmokePage() {
  const rows = await db.select().from(users).limit(1);
  const user = rows[0] ?? null;

  await kv.put('smoke', 'ok');
  const kvValue = await kv.get<string>('smoke');

  return (
    <div style={{ padding: '16px' }}>
      <h1>Smoke Test</h1>
      <p>
        D1 user: <span data-testid="d1-user">{user?.name ?? 'none'}</span>
      </p>
      <p>
        KV value: <span data-testid="kv-value">{kvValue ?? 'none'}</span>
      </p>
    </div>
  );
}
