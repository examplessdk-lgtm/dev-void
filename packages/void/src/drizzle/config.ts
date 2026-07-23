import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'pathslash';
import { readProjectPaths } from '../project-paths.ts';
import { discoverSchema, schemaSpecifier } from './discover.ts';

/**
 * Write a temporary drizzle-kit config to `.void/drizzle.config.json`.
 * All paths are relative to the project root (drizzle-kit resolves
 * relative to `--config` file location, so we use project-root-relative).
 *
 * @returns Absolute path to the written config file.
 */
export function writeDrizzleConfig(
  root: string,
  dbPath: string,
  dialect: 'sqlite' | 'postgresql' = 'sqlite',
): string {
  const paths = readProjectPaths(root);
  const schema = discoverSchema(root, paths);
  if (!schema) {
    throw new Error(
      `db: No Drizzle schema found. Create ${paths.sourceRelative('db/schema.ts')} or run \`void gen model <name>\`.`,
    );
  }

  const outDir = join(root, '.void');
  mkdirSync(outDir, { recursive: true });

  const config =
    dialect === 'postgresql'
      ? {
          dialect: 'postgresql',
          schema: schemaSpecifier(schema, root),
          out: `./${relative(root, paths.migrationsDir)}`,
          migrations: { prefix: 'timestamp' },
          dbCredentials: { url: dbPath },
        }
      : {
          dialect: 'sqlite',
          schema: schemaSpecifier(schema, root),
          out: `./${relative(root, paths.migrationsDir)}`,
          migrations: { prefix: 'timestamp' },
          dbCredentials: { url: dbPath },
        };

  const configPath = join(outDir, 'drizzle.config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  return configPath;
}
