import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ProjectTsconfigOptions {
  redirectDbModule?: boolean;
}

export interface ProjectTsconfig {
  files: Array<string>;
  compilerOptions?: {
    paths?: Record<string, Array<string>>;
  };
}

/**
 * Build the generated .void/tsconfig.json contents. Lists the generated
 * declaration files so TypeScript discovers them via the `files` field
 * (which is inherited by `extends`, unlike `include`).
 *
 * @param hasRouteTypes - When true, include routes.d.ts. When omitted,
 *   auto-detect by checking for a routes/ directory.
 * @param hasDrizzle - When true, configure `@schema` paths for the user's
 *   Drizzle schema.
 */
export function createProjectTsconfig(
  root: string,
  hasRouteTypes?: boolean,
  hasDb?: boolean,
  hasSchema?: boolean,
  options: ProjectTsconfigOptions = {},
): ProjectTsconfig {
  const outDir = join(root, '.void');
  const includeRoutes = hasRouteTypes ?? existsSync(join(root, 'routes'));
  const includeQueues = existsSync(join(root, 'queues'));
  const includeMd = existsSync(join(outDir, 'md.d.ts'));
  const includeEnv = existsSync(join(outDir, 'env.d.ts'));
  const files = [
    ...(includeRoutes ? ['routes.d.ts'] : []),
    ...(hasDb ? ['db.d.ts'] : []),
    ...(includeQueues ? ['queues.d.ts'] : []),
    ...(includeMd ? ['md.d.ts'] : []),
    ...(includeEnv ? ['env.d.ts'] : []),
  ];

  const tsconfig: ProjectTsconfig = { files };

  if (hasDb) {
    const paths: Record<string, Array<string>> = {};

    if (options.redirectDbModule !== false) {
      // Redirect void/db to the generated db.d.ts so TypeScript uses
      // schema-aware types instead of the generic base module.
      // (moduleResolution: "bundler" ignores ambient `declare module`
      // when the module resolves to a real file — paths is the fix.)
      paths['void/db'] = ['./db.d.ts'];
    }

    if (hasSchema) {
      // Determine whether schema is a file or directory
      const isDir =
        existsSync(join(root, 'db', 'schema')) && !existsSync(join(root, 'db', 'schema.ts'));

      // Paths are relative to .void/ (where this tsconfig lives), so use ../
      paths['@schema'] = [isDir ? '../db/schema/index.ts' : '../db/schema.ts'];
      paths['@schema/*'] = ['../db/schema/*'];
    }

    tsconfig.compilerOptions = { paths };
  }

  if (includeRoutes) {
    const compilerOptions = (tsconfig.compilerOptions ??= {});
    const paths = (compilerOptions.paths ??= {});

    // moduleResolution: "bundler" prefers the resolved package file for
    // void/routes, so point it at the generated declaration module directly.
    paths['void/routes'] = ['./routes.d.ts'];
  }

  if (includeQueues) {
    const compilerOptions = (tsconfig.compilerOptions ??= {});
    const paths = (compilerOptions.paths ??= {});

    // Same issue as void/routes: with moduleResolution "bundler", TypeScript
    // prefers the package export file unless we point it at the generated
    // project-local declaration module.
    paths['void/queues'] = ['./queues.d.ts'];
  }

  if (includeMd) {
    const compilerOptions = (tsconfig.compilerOptions ??= {});
    const paths = (compilerOptions.paths ??= {});

    // Override the package export stub with the generated project-local
    // declaration so TypeScript uses project-specific page types.
    paths['@void/md/pages'] = ['./md.d.ts'];
  }

  return tsconfig;
}

/**
 * Ensure .void/tsconfig.json exists so the user's root tsconfig can extend it.
 */
export function ensureProjectTsconfig(
  root: string,
  hasRouteTypes?: boolean,
  hasDb?: boolean,
  hasSchema?: boolean,
  options: ProjectTsconfigOptions = {},
): void {
  const outDir = join(root, '.void');
  mkdirSync(outDir, { recursive: true });
  const tsconfig = createProjectTsconfig(root, hasRouteTypes, hasDb, hasSchema, options);
  writeFileSync(join(outDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2) + '\n');
}
