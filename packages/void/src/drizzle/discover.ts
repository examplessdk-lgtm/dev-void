import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export type SchemaLocation = { type: "file"; path: string } | { type: "directory"; path: string };

/**
 * Discover the user's Drizzle schema.
 *
 * Resolution order:
 * 1. `db/schema.ts` (single file or barrel re-export)
 * 2. `db/schema/` directory (glob pattern for Drizzle Kit)
 *
 * Returns null if no schema is found.
 */
export function discoverSchema(root: string): SchemaLocation | null {
  const filePath = join(root, "db", "schema.ts");
  if (existsSync(filePath) && statSync(filePath).isFile()) {
    return { type: "file", path: filePath };
  }

  const dirPath = join(root, "db", "schema");
  if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
    return { type: "directory", path: dirPath };
  }

  return null;
}

/**
 * Resolve the schema specifier for Drizzle Kit config.
 * - File: `"./db/schema.ts"`
 * - Directory: `"./db/schema/*.ts"`
 */
export function schemaSpecifier(location: SchemaLocation): string {
  return location.type === "file" ? "./db/schema.ts" : "./db/schema/*.ts";
}
