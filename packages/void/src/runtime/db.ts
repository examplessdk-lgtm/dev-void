/**
 * void/db — Drizzle-powered database access.
 *
 * At build time, the Void plugin intercepts this import and serves a
 * virtual module that auto-wires the D1 binding with the user's schema.
 * This stub exists for the published npm package and type declarations.
 */
import { drizzle as _drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { requireRuntimeBinding } from './env';

// Re-export commonly used Drizzle utilities so consumers never need
// to depend on drizzle-orm directly.
export {
  sql,
  eq,
  ne,
  gt,
  gte,
  lt,
  lte,
  and,
  or,
  not,
  desc,
  asc,
  like,
  ilike,
  notLike,
  inArray,
  notInArray,
  isNull,
  isNotNull,
  between,
  notBetween,
  exists,
  notExists,
  count,
  sum,
  avg,
  min,
  max,
} from 'drizzle-orm';
export type { DrizzleD1Database } from 'drizzle-orm/d1';

/**
 * Create a Drizzle D1 instance from a custom D1 binding.
 * Use this when you have multiple D1 databases or need a non-default binding.
 */
export function createDb(d1: D1Database): DrizzleD1Database {
  return _drizzle(d1);
}

let _instance: DrizzleD1Database | undefined;

/**
 * Default Drizzle D1 instance — resolves the `DB` binding from the runtime
 * environment. When the Void plugin is active, this is replaced with a
 * schema-aware instance via virtual module.
 */
export const db: DrizzleD1Database = new Proxy({} as DrizzleD1Database, {
  get(_, prop) {
    _instance ??= _drizzle(requireRuntimeBinding<D1Database>('DB'));
    return Reflect.get(_instance, prop);
  },
});
