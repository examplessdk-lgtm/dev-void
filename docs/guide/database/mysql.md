---
outline: deep
---

# MySQL

Connect your MySQL database through [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/), then define tables and query them with Drizzle. Void configures the connection and applies your migrations when you deploy.

## Configure

Set the dialect in `void.config.ts`:

```json
{
  "database": "mysql"
}
```

Add a direct connection for local development:

```dotenv
DATABASE_URL=mysql://user:password@host:3306/app
```

Void reads `.env` for `void dev` and `void db` commands. In production, the Worker connects through the inferred `HYPERDRIVE` binding.

## Define a schema

```ts
// db/schema.ts
import { int, mysqlTable, text, timestamp } from 'void/schema-mysql';

export const messages = mysqlTable('messages', {
  id: int('id').autoincrement().primaryKey(),
  text: text('text').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
```

`void gen model` generates MySQL builders automatically when the project uses the MySQL dialect.

## Migrations

Use the normal workflow:

```sh
void db generate
void db migrate
void deploy
```

For direct Cloudflare deploys, export the production `DATABASE_URL` in the shell running `void deploy --platform cloudflare`. Void uses it to provision Hyperdrive and apply pending checked-in migrations before uploading the Worker; it is not written to the Worker config.

### Failed migrations {#failed-migrations}

Each migration file runs in a transaction, so a failed file that only changes data leaves the database unchanged. MySQL commits schema changes such as `CREATE TABLE` and `ALTER TABLE` immediately, so when a file with schema changes fails partway through, its earlier statements stay applied. The error names the file that failed.

To recover, undo the applied statements, fix the file, then run `void db migrate` or `void deploy` again:

```sh
void db execute "DROP TABLE comments"
void db execute --remote "DROP TABLE comments" # deployed database
```

MySQL rejects `IF NOT EXISTS` on `ADD COLUMN` and `CREATE INDEX`, so undoing a statement is usually simpler than making it safe to rerun. Small migrations leave less to undo.

## Database commands

`void db push`, `generate`, `migrate`, `status`, `reset`, `seed`, `execute`, `studio`, `export`, `rename-migrations`, and `set-url` all understand MySQL. Local commands use `DATABASE_URL` from `.env`; `--remote` execution and Studio use the encrypted URL stored for a linked Void project.
