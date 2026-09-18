import { eq, sql } from 'drizzle-orm';
import type { DbOrTx } from './db.ts';
import { platformSettings } from './schema.ts';

/** Reads one installation setting; `null` when it was never written. */
export async function getPlatformSetting(db: DbOrTx, key: string): Promise<unknown | null> {
  const rows = await db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, key))
    .limit(1);
  return rows[0]?.value ?? null;
}

export async function setPlatformSetting(db: DbOrTx, key: string, value: unknown): Promise<void> {
  await db
    .insert(platformSettings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: platformSettings.key,
      set: { value, updated_at: sql`now()` },
    });
}
