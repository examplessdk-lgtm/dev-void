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
  hasDrizzle?: boolean,
): void {
  const outDir = join(root, ".void");
  mkdirSync(outDir, { recursive: true });
  const includeRoutes = hasRouteTypes ?? existsSync(join(root, "routes"));
  const includeQueues = existsSync(join(root, "queues"));
  const files = [
    ...(includeRoutes ? ["routes.d.ts"] : []),
    ...(hasDrizzle ? ["db.d.ts"] : []),
    ...(includeQueues ? ["queues.d.ts"] : []),
  ];

  const tsconfig: Record<string, unknown> = { files };

  if (hasDrizzle) {
    // Determine whether schema is a file or directory
    const isDir =
      existsSync(join(root, "db", "schema")) && !existsSync(join(root, "db", "schema.ts"));

    // Paths are relative to .void/ (where this tsconfig lives), so use ../
    tsconfig.compilerOptions = {
      paths: {
        "@schema": isDir ? ["../db/schema/index.ts"] : ["../db/schema.ts"],
        "@schema/*": ["../db/schema/*"],
        // Redirect void/db to the generated db.d.ts so TypeScript uses
        // schema-aware types instead of the generic base module.
        // (moduleResolution: "bundler" ignores ambient `declare module`
        // when the module resolves to a real file — paths is the fix.)
        "void/db": ["./db.d.ts"],
      },
    };
  }

  writeFileSync(join(outDir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2) + "\n");
}
