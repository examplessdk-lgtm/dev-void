import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize, relative } from 'pathslash';
import type { VoidConfig } from './config.ts';

const SOURCE_CONVENTION_DIRECTORIES = [
  'routes',
  'pages',
  'middleware',
  'crons',
  'queues',
  'db',
] as const;

const AUTH_CONFIG_FILES = [
  'auth.ts',
  'auth.mts',
  'auth.js',
  'auth.mjs',
  'auth.cts',
  'auth.cjs',
] as const;

const ENV_CONFIG_FILES = ['env.ts', 'env.mts', 'env.js', 'env.mjs'] as const;

const SOURCE_CONVENTIONS = new Set<string>([
  ...SOURCE_CONVENTION_DIRECTORIES,
  ...AUTH_CONFIG_FILES,
  ...ENV_CONFIG_FILES,
]);

export type ProjectPaths = {
  root: string;
  sourceDir: string;
  sourceRoot: string;
  routesDir: string;
  middlewareDir: string;
  cronsDir: string;
  queuesDir: string;
  pagesDir: string;
  dbDir: string;
  migrationsDir: string;
  schemaFile: string;
  schemaDir: string;
  srcDir: string;
  ssrDir: string;
  sourceRelative: (path: string) => string;
  authConfigCandidates: ReadonlyArray<string>;
  envFileCandidates: ReadonlyArray<string>;
};

export function validateSourceDir(value: string, label = 'sourceDir'): string {
  if (value.trim() !== value || value.length === 0) {
    throw new Error(`config: "${label}" in void.json must be a non-empty relative directory.`);
  }
  if (
    value === '.' ||
    value === '..' ||
    value.startsWith('../') ||
    value.includes('/../') ||
    value.endsWith('/..') ||
    isAbsolute(value)
  ) {
    throw new Error(
      `config: "${label}" path '${value}' in void.json must be a relative directory.`,
    );
  }
  const normalized = normalize(value).replace(/\/+$/, '');
  if (normalized === '' || normalized === '.') {
    throw new Error(
      `config: "${label}" path '${value}' in void.json must be a relative directory.`,
    );
  }
  return normalized;
}

function getSourceDir(config?: VoidConfig): string {
  return config?.sourceDir ? validateSourceDir(config.sourceDir) : '';
}

function resolveCandidate(root: string, sourceDir: string, candidate: string): string {
  return sourceDir ? join(root, sourceDir, candidate) : join(root, candidate);
}

export function resolveProjectPaths(root: string, config?: VoidConfig): ProjectPaths {
  const sourceDir = getSourceDir(config);
  const sourceRoot = sourceDir ? join(root, sourceDir) : root;
  const sourceRelative = (path: string) => (sourceDir ? `${sourceDir}/${path}` : path);

  const envFileCandidates = sourceDir
    ? ENV_CONFIG_FILES.map((file) => join(sourceRoot, file))
    : [
        ...ENV_CONFIG_FILES.map((file) => join(root, file)),
        ...ENV_CONFIG_FILES.map((file) => join(root, 'src', file)),
      ];

  return {
    root,
    sourceDir,
    sourceRoot,
    routesDir: join(sourceRoot, 'routes'),
    middlewareDir: join(sourceRoot, 'middleware'),
    cronsDir: join(sourceRoot, 'crons'),
    queuesDir: join(sourceRoot, 'queues'),
    pagesDir: join(sourceRoot, 'pages'),
    dbDir: join(sourceRoot, 'db'),
    migrationsDir: join(sourceRoot, 'db', 'migrations'),
    schemaFile: join(sourceRoot, 'db', 'schema.ts'),
    schemaDir: join(sourceRoot, 'db', 'schema'),
    srcDir: join(sourceRoot, 'src'),
    ssrDir: sourceDir ? sourceRoot : join(root, 'src'),
    sourceRelative,
    authConfigCandidates: AUTH_CONFIG_FILES.map((file) => resolveCandidate(root, sourceDir, file)),
    envFileCandidates,
  };
}

export function readProjectPaths(root: string): ProjectPaths {
  return resolveProjectPaths(root, readSourceDirConfig(root));
}

function readSourceDirConfig(root: string): Pick<VoidConfig, 'sourceDir'> {
  let raw: string;
  try {
    raw = readFileSync(join(root, 'void.json'), 'utf-8');
  } catch {
    return {};
  }

  let config: unknown;
  try {
    config = JSON.parse(raw);
  } catch {
    return {};
  }

  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return {};
  }

  const sourceDir = (config as Record<string, unknown>).sourceDir;
  return typeof sourceDir === 'string' ? { sourceDir } : {};
}

export function resolvePagesDir(root: string = process.cwd()): string {
  return readProjectPaths(root).pagesDir;
}

export function assertNoRootSourceConventionConflicts(paths: ProjectPaths): void {
  if (!paths.sourceDir) {
    return;
  }
  const conflicts = Array.from(SOURCE_CONVENTIONS).filter(
    (convention) =>
      existsSync(join(paths.root, convention)) && existsSync(join(paths.sourceRoot, convention)),
  );
  if (conflicts.length === 0) {
    return;
  }
  const relSource = relative(paths.root, paths.sourceRoot);
  throw new Error(
    `sourceDir: void.json sets "sourceDir": "${paths.sourceDir}", but convention path(s) also exist at the project root: ${conflicts.join(', ')}. Move them under "${relSource}" or remove the root copy.`,
  );
}
