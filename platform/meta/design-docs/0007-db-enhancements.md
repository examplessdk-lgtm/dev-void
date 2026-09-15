# DB Query Enhancements

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

**Date:** 2026-02-17
**Status:** All implemented

---

All four proposed enhancements have been implemented in `packages/void/src/runtime/db.ts`:

1. **Column selection** — `select?: (keyof Row<T> & string)[]` on `list` and `get`. Return type narrows to `Pick<Row<T>, K>`.

2. **`IN` operator** — `WhereClause` accepts arrays: `{ status: ["active", "pending"] }` → `WHERE status IN (...)`. Implemented via `Array.isArray(value)` check in `buildWhere()`.

3. **`orderBy` as array** — `orderBy?: OrderExpr<T> | OrderExpr<T>[]` for multi-column sorting.

4. **`count` method** — `count(table, options?)` returns `Promise<number>`. Uses `SELECT COUNT(*) AS count`.

The API boundary remains at "zero learning curve CRUD helper" — comparison operators, joins, and aggregations are deliberately excluded (use `db.raw()` for those).
