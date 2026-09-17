type QueryClient = {
  query<T extends Record<string, unknown>>(
    sql: string,
    params?: Array<unknown>,
  ): Promise<{ rows: Array<T> }>;
};

export function quoteSqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Restore SERIAL dependencies before tables, ownership/state after their data. */
export async function exportPgSequences(
  client: QueryClient,
  tables: Array<string>,
  options: { noSchema?: boolean; noData?: boolean },
): Promise<{ before: Array<string>; after: Array<string> }> {
  const result = await client.query<{
    schema_name: string;
    sequence_name: string;
    table_name: string;
    column_name: string;
    data_type: string;
    start_value: string;
    increment_by: string;
    min_value: string;
    max_value: string;
    cache_size: string;
    cycle: boolean;
  }>(
    `SELECT ns.nspname AS schema_name, seq.relname AS sequence_name,
      tbl.relname AS table_name, col.attname AS column_name,
      format_type(s.seqtypid, NULL) AS data_type,
      s.seqstart::text AS start_value, s.seqincrement::text AS increment_by,
      s.seqmin::text AS min_value, s.seqmax::text AS max_value,
      s.seqcache::text AS cache_size, s.seqcycle AS cycle
    FROM pg_sequence s
    JOIN pg_class seq ON seq.oid = s.seqrelid
    JOIN pg_namespace ns ON ns.oid = seq.relnamespace
    JOIN pg_depend dep ON dep.objid = seq.oid AND dep.classid = 'pg_class'::regclass AND dep.deptype = 'a'
    JOIN pg_class tbl ON tbl.oid = dep.refobjid
    JOIN pg_namespace tblns ON tblns.oid = tbl.relnamespace
    JOIN pg_attribute col ON col.attrelid = tbl.oid AND col.attnum = dep.refobjsubid
    WHERE tblns.nspname = 'public' AND tbl.relname = ANY($1::text[])
    ORDER BY ns.nspname, seq.relname`,
    [tables],
  );
  const before: Array<string> = [];
  const after: Array<string> = [];
  for (const seq of result.rows) {
    const name = `${quoteSqlIdentifier(seq.schema_name)}.${quoteSqlIdentifier(seq.sequence_name)}`;
    if (!options.noSchema) {
      before.push(
        `CREATE SEQUENCE ${name} AS ${seq.data_type} INCREMENT BY ${seq.increment_by} MINVALUE ${seq.min_value} MAXVALUE ${seq.max_value} START WITH ${seq.start_value} CACHE ${seq.cache_size} ${seq.cycle ? 'CYCLE' : 'NO CYCLE'};`,
      );
      after.push(
        `ALTER SEQUENCE ${name} OWNED BY "public".${quoteSqlIdentifier(seq.table_name)}.${quoteSqlIdentifier(seq.column_name)};`,
      );
    }
    if (!options.noData) {
      const state = await client.query<{ last_value: string; is_called: boolean }>(
        `SELECT last_value::text, is_called FROM ${name}`,
      );
      const value = state.rows[0];
      after.push(
        `SELECT pg_catalog.setval(${quoteSqlString(name)}, ${value.last_value}, ${value.is_called});`,
      );
    }
  }
  return { before, after };
}

/** Add constraints after all tables/data so cross-table references can resolve. */
export async function exportPgConstraints(
  client: QueryClient,
  tables: Array<string>,
): Promise<Array<string>> {
  const constraints = await client.query<{ table_name: string; name: string; definition: string }>(
    `
    SELECT tbl.relname AS table_name, con.conname AS name, pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con JOIN pg_class tbl ON tbl.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
    WHERE ns.nspname = 'public' AND tbl.relname = ANY($1::text[])
      AND con.contype IN ('p', 'u', 'f', 'c', 'x')
    ORDER BY CASE WHEN con.contype = 'f' THEN 1 ELSE 0 END, tbl.relname, con.conname`,
    [tables],
  );
  const indexes = await client.query<{ definition: string }>(
    `
    SELECT pg_get_indexdef(idx.indexrelid) AS definition
    FROM pg_index idx JOIN pg_class tbl ON tbl.oid = idx.indrelid
    JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
    WHERE ns.nspname = 'public' AND tbl.relname = ANY($1::text[])
      AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = idx.indexrelid)
    ORDER BY idx.indexrelid`,
    [tables],
  );
  return [
    ...constraints.rows.map(
      (row) =>
        `ALTER TABLE "public".${quoteSqlIdentifier(row.table_name)} ADD CONSTRAINT ${quoteSqlIdentifier(row.name)} ${row.definition};`,
    ),
    ...indexes.rows.map((row) => row.definition + ';'),
  ];
}
