import { existsSync, statSync } from 'node:fs';
import { relative } from 'pathe';
import { readProjectPaths, type ProjectPaths } from '../project-paths.ts';

export type SchemaLocation = { type: 'file'; path: string } | { type: 'directory'; path: string };

/**
 * Discover the user's Drizzle schema.
 *
 * Resolution order:
 * 1. `db/schema.ts` (single file or barrel re-export)
 * 2. `db/schema/` directory (glob pattern for Drizzle Kit)
 *
 * Returns null if no schema is found.
 */
export function discoverSchema(
  root: string,
  paths: ProjectPaths = readProjectPaths(root),
): SchemaLocation | null {
  const filePath = paths.schemaFile;
  if (existsSync(filePath) && statSync(filePath).isFile()) {
    return { type: 'file', path: filePath };
  }

  const dirPath = paths.schemaDir;
  if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
    return { type: 'directory', path: dirPath };
  }

  return null;
}

/**
 * Resolve the schema specifier for Drizzle Kit config.
 * - File: `"./db/schema.ts"`
 * - Directory: `"./db/schema/*.ts"`
 */
export function schemaSpecifier(location: SchemaLocation, root?: string): string {
  if (!root) {
    return location.type === 'file' ? './db/schema.ts' : './db/schema/*.ts';
  }
  const rel = relative(root, location.path);
  return location.type === 'file' ? `./${rel}` : `./${rel}/*.ts`;
}
