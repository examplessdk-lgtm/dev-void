import { db } from 'void/db';
import { kv } from 'void/kv';
import { users } from '../db/schema.ts';

export const cron = '0 * * * *';

export default async function heartbeat() {
  const now = new Date().toISOString();
  await db.insert(users).values({ name: `cron-${now}`, email: `cron-${now}@local` });
  await kv.put('last-cron-run', now);
  console.log('[cron] heartbeat fired at', now);
}
