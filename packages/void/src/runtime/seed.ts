import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export interface SqliteSeedContext<
  TSchema extends Record<string, unknown> = Record<string, never>,
> {
  dialect: 'sqlite';
  db: BetterSQLite3Database<TSchema>;
  schema: TSchema;
}

export interface PostgresSeedContext<
  TSchema extends Record<string, unknown> = Record<string, never>,
> {
  dialect: 'postgresql';
  db: NodePgDatabase<TSchema>;
  schema: TSchema;
}

export type SeedContext<TSchema extends Record<string, unknown> = Record<string, never>> =
  | SqliteSeedContext<TSchema>
  | PostgresSeedContext<TSchema>;

export type SeedFn<TSchema extends Record<string, unknown> = Record<string, never>> = (
  context: SeedContext<TSchema>,
) => void | Promise<void>;

export function defineSeed<TSchema extends Record<string, unknown> = Record<string, never>>(
  seed: SeedFn<TSchema>,
): SeedFn<TSchema> {
  return seed;
}
