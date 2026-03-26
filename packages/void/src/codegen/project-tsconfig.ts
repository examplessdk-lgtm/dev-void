import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Ensure .void/tsconfig.json exists so the user's root tsconfig can
 * extend it. Lists the generated declaration files so TypeScript discovers
 * them via the `files` field (which is inherited by `extends`, unlike `include`).
 *
 * @param hasRouteTypes - When true, include routes.d.ts. When omitted,
 *   auto-detect by checking for a routes/ directory.
 * @param hasDrizzle - When true, configure `@schema` paths for the user's
 *   Drizzle schema.
 */
export function ensureProjectTsconfig(
  root: string,
  hasRouteTypes?: boolean,
  hasDb?: boolean,
  hasSchema?: boolean,
  options: { redirectDbModule?: boolean } = {},
): void {
  const outDir = join(root, ".void");
  mkdirSync(outDir, { recursive: true });
  const includeRoutes = hasRouteTypes ?? existsSync(join(root, "routes"));
  const includeQueues = existsSync(join(root, "queues"));
  const files = [
    ...(includeRoutes ? ["routes.d.ts"] : []),
    ...(hasDb ? ["db.d.ts"] : []),
    ...(includeQueues ? ["queues.d.ts"] : []),
  ];

  const tsconfig: Record<string, unknown> = { files };

  if (hasDb) {
    const paths: Record<string, string[]> = {};

    if (options.redirectDbModule !== false) {
      // Redirect void/db to the generated db.d.ts so TypeScript uses
      // schema-aware types instead of the generic base module.
      // (moduleResolution: "bundler" ignores ambient `declare module`
      // when the module resolves to a real file — paths is the fix.)
      paths["void/db"] = ["./db.d.ts"];
    }

    if (hasSchema) {
      // Determine whether schema is a file or directory
      const isDir =
        existsSync(join(root, "db", "schema")) && !existsSync(join(root, "db", "schema.ts"));

      // Paths are relative to .void/ (where this tsconfig lives), so use ../
      paths["@schema"] = [isDir ? "../db/schema/index.ts" : "../db/schema.ts"];
      paths["@schema/*"] = ["../db/schema/*"];
    }

    tsconfig.compilerOptions = { paths };
  }

  writeFileSync(join(outDir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2) + "\n");
}
