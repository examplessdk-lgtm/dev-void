import { spawnSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { intro, outro, log, confirm, isCancel, cancel, note, select } from '@clack/prompts';
import { parse, type ParseError } from 'jsonc-parser';
import { ensureProjectTsconfig } from '../codegen/project-tsconfig';
import { getDatabaseDialect, readConfig, type DatabaseDialect } from '../config';
import { writeDrizzleConfig } from '../drizzle/config';
import { detectFramework, type DetectedFramework } from '../plugin-inference';
import {
  detectAgents,
  getAgentById,
  getPackageDir,
  type AgentConfig,
  type McpConfigTarget,
} from './agents';
import { maybeSetupDeployProject } from './deploy-setup';
import { formatTimestamp } from './gen';
import { cliTitle } from './output';
import { formatProjectCommand } from './preset';
import {
  createPagesStarterTemplate,
  detectScaffoldFrameworkFromDependencies,
  getScaffoldTsconfigCompilerOptions,
  SCAFFOLD_FRAMEWORKS,
  SCAFFOLD_FRAMEWORK_OPTIONS,
  SCAFFOLD_GITIGNORE_LINES,
  type ScaffoldFramework,
  type ScaffoldStarterMode,
} from './template';

export interface InitArgs {
  tsconfig: boolean;
  github: boolean;
  agents: boolean;
}

export function parseInitArgs(args: string[]): InitArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      options: {
        tsconfig: { type: 'boolean' },
        github: { type: 'boolean' },
        agents: { type: 'boolean' },
      },
      strict: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Error: ${message}`);
  }

  return {
    tsconfig: parsed.values.tsconfig === true,
    github: parsed.values.github === true,
    agents: parsed.values.agents === true,
  };
}

const EMPTY_PROJECT_ALLOWED_ENTRIES = new Set([
  '.git',
  '.gitignore',
  'AGENTS.md',
  'CLAUDE.md',
  '.node-version',
  '.npmrc',
  '.nvmrc',
  '.editorconfig',
  '.vscode',
  '.idea',
  '.DS_Store',
  'node_modules',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  '.agents',
  '.claude',
  '.cline',
  '.codex',
  '.continue',
  '.cursor',
  '.gemini',
  '.goose',
  '.junie',
  '.kilocode',
  '.kiro',
  '.opencode',
  '.qwen',
  '.roo',
  '.trae',
  '.windsurf',
  '.zencoder',
]);

const PNPM_ONLY_BUILT_DEPENDENCIES = ['better-sqlite3', 'esbuild', 'workerd'] as const;
const drizzleKitBin = join(fileURLToPath(import.meta.resolve('drizzle-kit')), '..', 'bin.cjs');

const EMPTY_PROJECT_ALLOWED_PACKAGES = new Set([
  'void',
  '@void-sdk/void',
  '@void/react',
  '@void/vue',
  '@void/svelte',
  '@void/solid',
  '@void-sdk/react',
  '@void-sdk/vue',
  '@void-sdk/svelte',
  '@void-sdk/solid',
]);

const VITE_CONFIG_FILES = [
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mts',
  'vite.config.mjs',
  'vite.config.cts',
  'vite.config.cjs',
];
const VOID_CONFIG_FILE = 'void.json';
type DatabaseSetupChoice = DatabaseDialect | 'none';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function isScaffoldableEmptyProject(root: string): boolean {
  for (const dir of [
    'src',
    'routes',
    'db',
    'migrations',
    'middleware',
    'crons',
    'queues',
    'pages',
  ]) {
    if (existsSync(join(root, dir))) {
      return false;
    }
  }
  if (existsSync(join(root, 'index.html'))) {
    return false;
  }
  for (const file of VITE_CONFIG_FILES) {
    if (existsSync(join(root, file))) {
      return false;
    }
  }

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (EMPTY_PROJECT_ALLOWED_ENTRIES.has(entry.name)) {
      continue;
    }
    if (entry.name.startsWith('README')) {
      continue;
    }
    return false;
  }

  const packageJsonPath = join(root, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return true;
  }

  let pkgRaw: unknown;
  try {
    pkgRaw = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  } catch {
    return false;
  }
  const pkg = asRecord(pkgRaw);
  if (!pkg) {
    return false;
  }

  const deps = {
    ...(asRecord(pkg.dependencies) ?? {}),
    ...(asRecord(pkg.devDependencies) ?? {}),
  };
  if (Object.keys(deps).some((dep) => !EMPTY_PROJECT_ALLOWED_PACKAGES.has(dep))) {
    return false;
  }

  const scripts = asRecord(pkg.scripts) ?? {};
  if (Object.keys(scripts).some((name) => name !== 'test')) {
    return false;
  }

  return true;
}

interface ProjectState {
  hasTypescript: boolean;
  hasTsconfig: boolean;
  hasGithubWorkflows: boolean;
  hasRoutes: boolean;
  hasMigrations: boolean;
  hasPages: boolean;
  packageManager: 'pnpm' | 'yarn' | 'bun' | 'npm';
  typescriptWanted: boolean;
}

function detectProjectState(root: string): ProjectState {
  let hasTypescript = false;
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    hasTypescript = 'typescript' in allDeps || '@typescript/native-preview' in allDeps;
  } catch {
    // no package.json
  }

  let packageManager: ProjectState['packageManager'] = 'npm';
  if (existsSync(join(root, 'pnpm-lock.yaml'))) {
    packageManager = 'pnpm';
  } else if (existsSync(join(root, 'yarn.lock'))) {
    packageManager = 'yarn';
  } else if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))) {
    packageManager = 'bun';
  }

  return {
    hasTypescript,
    hasTsconfig: existsSync(join(root, 'tsconfig.json')),
    hasGithubWorkflows: existsSync(join(root, '.github', 'workflows')),
    hasRoutes: existsSync(join(root, 'routes')),
    hasMigrations:
      existsSync(join(root, 'db', 'migrations')) || existsSync(join(root, 'migrations')),
    hasPages: existsSync(join(root, 'pages')),
    packageManager,
    typescriptWanted: hasTypescript,
  };
}

function hasDrizzleSchema(root: string): boolean {
  return existsSync(join(root, 'db', 'schema.ts')) || existsSync(join(root, 'db', 'schema'));
}

function detectPagesFramework(root: string): ScaffoldFramework | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    const deps = {
      ...(asRecord(pkg.dependencies) ?? {}),
      ...(asRecord(pkg.devDependencies) ?? {}),
    };
    return detectScaffoldFrameworkFromDependencies(deps);
  } catch {
    return undefined;
  }
}

function readPackageJson(root: string): Record<string, any> | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    return asRecord(pkg) ?? undefined;
  } catch {
    return undefined;
  }
}

function getDeclaredDependencySpec(root: string, packageName: string): string | undefined {
  const pkg = readPackageJson(root);
  if (!pkg) {
    return undefined;
  }

  const dependencies = asRecord(pkg.dependencies);
  if (typeof dependencies?.[packageName] === 'string') {
    return dependencies[packageName] as string;
  }

  const devDependencies = asRecord(pkg.devDependencies);
  if (typeof devDependencies?.[packageName] === 'string') {
    return devDependencies[packageName] as string;
  }

  return undefined;
}

function toPreviewPackageName(publicPackageName: string): string {
  if (publicPackageName === 'void') {
    return '@void-sdk/void';
  }
  if (publicPackageName.startsWith('@void/')) {
    return publicPackageName.replace(/^@void\//, '@void-sdk/');
  }
  return publicPackageName;
}

function toAliasedPreviewSpec(
  previewPackageName: string,
  spec: string,
  fallbackVersion: string,
): string {
  if (spec.startsWith('npm:')) {
    return spec.replace(/@void-sdk\/[^@]+/, previewPackageName);
  }
  if (spec.startsWith('workspace:')) {
    return spec.replace(/@void-sdk\/[^@]+/, previewPackageName);
  }
  if (spec.startsWith('catalog:')) {
    return spec;
  }
  return `npm:${previewPackageName}@${spec || fallbackVersion}`;
}

function usesPreviewPackageAliases(root: string): boolean {
  const publicVoidSpec = getDeclaredDependencySpec(root, 'void');
  if (typeof publicVoidSpec === 'string' && publicVoidSpec.includes('@void-sdk/void')) {
    return true;
  }

  return typeof getDeclaredDependencySpec(root, '@void-sdk/void') === 'string';
}

function resolveScaffoldDependencySpec(
  root: string,
  packageName: string,
  fallbackVersion: string,
): string {
  const explicit = getDeclaredDependencySpec(root, packageName);
  if (explicit) {
    return explicit;
  }

  const previewPackageName = toPreviewPackageName(packageName);
  const previewSpec = getDeclaredDependencySpec(root, previewPackageName);
  if (previewSpec) {
    return toAliasedPreviewSpec(previewPackageName, previewSpec, fallbackVersion);
  }

  const existingVoidSpec =
    getDeclaredDependencySpec(root, 'void') ?? getDeclaredDependencySpec(root, '@void-sdk/void');
  if (packageName !== 'void' && existingVoidSpec && usesPreviewPackageAliases(root)) {
    return toAliasedPreviewSpec(previewPackageName, existingVoidSpec, fallbackVersion);
  }

  return `npm:${previewPackageName}@${fallbackVersion}`;
}

function setupTsconfig(
  root: string,
  state: ProjectState,
  pagesFramework?: ScaffoldFramework,
): void {
  const tsconfigPath = join(root, 'tsconfig.json');

  if (state.hasTsconfig) {
    // Case C: existing tsconfig — check and offer fixes
    let tsconfig: any;
    try {
      const raw = readFileSync(tsconfigPath, 'utf-8');
      const errors: ParseError[] = [];
      tsconfig = parse(raw, errors);
      if (errors.length > 0) {
        throw new SyntaxError('Failed to parse tsconfig.json');
      }
    } catch {
      log.warn('Could not parse tsconfig.json, skipping');
      return;
    }

    let updated = false;

    // Check extends
    const extendsValue = tsconfig.extends;
    const target = './.void/tsconfig.json';
    const hasCorrectExtends =
      extendsValue === target || (Array.isArray(extendsValue) && extendsValue.includes(target));

    if (!hasCorrectExtends) {
      if (typeof extendsValue === 'string') {
        tsconfig.extends = [extendsValue, target];
      } else if (Array.isArray(extendsValue)) {
        tsconfig.extends = [...extendsValue, target];
      } else {
        tsconfig.extends = target;
      }
      updated = true;
      log.success('Updated tsconfig.json — added extends .void/tsconfig.json');
    }

    // Check types
    if (!tsconfig.compilerOptions) {
      tsconfig.compilerOptions = {};
    }
    const types: string[] = tsconfig.compilerOptions.types ?? [];
    if (!types.includes('void/env')) {
      types.push('void/env');
      updated = true;
      log.success('Updated tsconfig.json — added void/env to types');
    }

    // Remove @cloudflare/workers-types — void/env includes it
    const cfIdx = types.indexOf('@cloudflare/workers-types');
    if (cfIdx !== -1) {
      types.splice(cfIdx, 1);
      updated = true;
      log.success('Removed @cloudflare/workers-types from tsconfig types (included in void/env)');
    }

    tsconfig.compilerOptions.types = types;

    if (updated) {
      // Rebuild with extends first so it appears at the top of the file
      const { extends: ext, ...rest } = tsconfig;
      const ordered = { extends: ext, ...rest };
      writeFileSync(tsconfigPath, JSON.stringify(ordered, null, 2) + '\n');
    } else {
      log.success('tsconfig.json looks good');
    }

    // Remove @cloudflare/workers-types from package.json — void/env includes it
    try {
      const pkgPath = join(root, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      let pkgUpdated = false;
      if (pkg.dependencies?.['@cloudflare/workers-types']) {
        delete pkg.dependencies['@cloudflare/workers-types'];
        pkgUpdated = true;
      }
      if (pkg.devDependencies?.['@cloudflare/workers-types']) {
        delete pkg.devDependencies['@cloudflare/workers-types'];
        pkgUpdated = true;
      }
      if (pkgUpdated) {
        writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
        log.success('Removed @cloudflare/workers-types from package.json (included in void/env)');
        log.info(`Re-run ${state.packageManager} install to update your lockfile`);
      }
    } catch {
      // no package.json or parse error — skip
    }
  } else {
    // Case B: no tsconfig — create recommended one
    const tsconfig = {
      extends: './.void/tsconfig.json',
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        types: ['void/env'],
        ...getScaffoldTsconfigCompilerOptions(pagesFramework),
      },
      include: ['src', 'pages', 'routes', 'middleware', 'crons', 'queues', 'db'],
    };
    writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2) + '\n');
    log.success('Created tsconfig.json');

    if (!state.hasTypescript) {
      log.info("Don't forget to install typescript");
    }
  }
}

/** Today's date as YYYY-MM-DD for wrangler compatibility_date. */
function getTodayCompatDate(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function readProjectWranglerCompatDate(root: string): string | undefined {
  for (const name of ['wrangler.jsonc', 'wrangler.json']) {
    const configPath = join(root, name);
    if (!existsSync(configPath)) {
      continue;
    }

    try {
      const raw = readFileSync(configPath, 'utf-8');
      const errors: ParseError[] = [];
      const parsed = parse(raw, errors);
      if (errors.length > 0) {
        throw new SyntaxError('Failed to parse JSONC');
      }
      if (typeof parsed?.compatibility_date === 'string') {
        return parsed.compatibility_date;
      }
    } catch {
      // Ignore unreadable or invalid wrangler config and fall back to today's date.
    }
  }

  return undefined;
}

/**
 * Ensure wrangler.jsonc exists with `compatibility_date` and `nodejs_als` flag
 * for class B/C meta-frameworks that need it for local dev.
 */
function setupWranglerConfig(root: string, framework: DetectedFramework): void {
  if (framework.class === 'a') {
    return;
  }

  let configPath: string | undefined;
  let parsed: Record<string, unknown> | undefined;
  let created = false;

  for (const name of ['wrangler.jsonc', 'wrangler.json']) {
    const p = join(root, name);
    if (existsSync(p)) {
      configPath = p;
      try {
        const raw = readFileSync(p, 'utf-8');
        const errors: ParseError[] = [];
        parsed = parse(raw, errors);
        if (errors.length > 0) {
          throw new SyntaxError('Failed to parse JSONC');
        }
      } catch {
        // unparseable — start fresh
      }
      break;
    }
  }

  if (!configPath || !parsed) {
    configPath = join(root, 'wrangler.jsonc');
    parsed = {};
    created = true;
  }

  let modified = false;

  // Ensure compatibility_date
  if (!parsed.compatibility_date) {
    parsed.compatibility_date = getTodayCompatDate();
    modified = true;
  }

  // Ensure nodejs_als flag
  const flags = Array.isArray(parsed.compatibility_flags)
    ? (parsed.compatibility_flags as string[])
    : [];
  if (!flags.includes('nodejs_als')) {
    parsed.compatibility_flags = [...flags, 'nodejs_als'];
    modified = true;
  }

  if (created || modified) {
    writeFileSync(configPath, JSON.stringify(parsed, null, 2) + '\n');
    if (created) {
      log.success('Created wrangler.jsonc with compatibility_date and nodejs_als');
    } else {
      log.success('Updated wrangler.jsonc with compatibility_date and nodejs_als');
    }
  } else {
    log.success('wrangler.jsonc looks good');
  }
}

function writeVoidConfig(root: string, config: Record<string, unknown>): void {
  writeFileSync(join(root, VOID_CONFIG_FILE), JSON.stringify(config, null, 2) + '\n');
}

function ensureVoidWorkerCompatibilityDate(root: string): void {
  const config = readConfig(root) as Record<string, unknown>;

  if (typeof config.target === 'string' && config.target !== 'cloudflare') {
    return;
  }

  const worker = asRecord(config.worker) ?? {};
  if (typeof worker.compatibility_date === 'string' && worker.compatibility_date.length > 0) {
    return;
  }

  const compatibilityDate = readProjectWranglerCompatDate(root) ?? getTodayCompatDate();
  config.worker = {
    ...worker,
    compatibility_date: compatibilityDate,
  };
  writeVoidConfig(root, config);
  log.success('Pinned worker compatibility_date in void.json');
}

function clearConfiguredDatabase(
  root: string,
  messages: { unchanged: string; updated: string },
): void {
  const config = readConfig(root) as Record<string, unknown>;
  const configPath = join(root, VOID_CONFIG_FILE);

  if (config.database !== 'pg') {
    log.info(messages.unchanged);
    return;
  }

  delete config.database;

  if (Object.keys(config).length === 0) {
    unlinkSync(configPath);
    log.success(messages.updated);
    return;
  }

  writeVoidConfig(root, config);
  log.success(messages.updated);
}

function applyDatabaseDialect(root: string, dialect: DatabaseDialect): void {
  const config = readConfig(root) as Record<string, unknown>;

  if (dialect === 'postgresql') {
    if (config.database === 'pg') {
      log.info('PostgreSQL already configured in void.json');
      return;
    }

    config.database = 'pg';
    writeVoidConfig(root, config);
    log.success('Configured PostgreSQL in void.json');
    return;
  }

  clearConfiguredDatabase(root, {
    unchanged: 'Using default D1 (SQLite) configuration',
    updated: 'Updated void.json to use the default D1 (SQLite) configuration',
  });
}

function detectDatabaseSetup(root: string): DatabaseSetupChoice {
  if (getDatabaseDialect(readConfig(root)) === 'postgresql') {
    return 'postgresql';
  }
  if (
    hasDrizzleSchema(root) ||
    existsSync(join(root, 'db', 'migrations')) ||
    existsSync(join(root, 'migrations'))
  ) {
    return 'sqlite';
  }
  return 'none';
}

function applyDatabaseSetup(root: string, choice: DatabaseSetupChoice): void {
  if (choice === 'none') {
    clearConfiguredDatabase(root, {
      unchanged: 'No database configured yet',
      updated: 'Removed database config from void.json',
    });
    return;
  }

  applyDatabaseDialect(root, choice);
}

async function promptStarterMode(): Promise<ScaffoldStarterMode> {
  const choice = await select({
    message: 'Choose a Pages starter:',
    options: [
      {
        value: 'sqlite',
        label: 'D1 (SQLite)',
        hint: 'Recommended starter. Scaffolds a DB-backed page, schema, generated migration, seed file, and API route.',
      },
      {
        value: 'postgresql',
        label: 'PostgreSQL',
        hint: 'Scaffolds the same starter with PostgreSQL, a generated migration, a seed file, and writes "database": "pg" to void.json.',
      },
      {
        value: 'static',
        label: 'Static Pages',
        hint: 'No database or server starter files yet. Good for content sites; add Void features later.',
      },
    ],
  });

  if (isCancel(choice)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  return choice as ScaffoldStarterMode;
}

async function promptScaffoldFramework(): Promise<ScaffoldFramework> {
  const choice = await select({
    message: 'Choose a Pages framework to scaffold:',
    options: [...SCAFFOLD_FRAMEWORK_OPTIONS],
  });

  if (isCancel(choice)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  return choice as ScaffoldFramework;
}

async function promptDatabaseSetup(root: string): Promise<DatabaseSetupChoice> {
  const currentSetup = detectDatabaseSetup(root);
  const initialValue = currentSetup === 'none' ? 'sqlite' : currentSetup;

  const choice = await select({
    message: 'Choose a database setup for this project:',
    initialValue,
    options: [
      {
        value: 'sqlite',
        label: currentSetup === 'sqlite' ? 'D1 (SQLite) [current]' : 'D1 (SQLite)',
        hint: 'Zero-config and fully managed by Void; best for prototyping and read-heavy apps.',
      },
      {
        value: 'postgresql',
        label: currentSetup === 'postgresql' ? 'PostgreSQL [current]' : 'PostgreSQL',
        hint: 'Bring your own Postgres via Hyperdrive; best for write-heavy apps, complex queries, or existing infra.',
      },
      {
        value: 'none',
        label: 'No Database Yet',
        hint: 'Skip database setup for now. You can add D1 or PostgreSQL later as your app grows.',
      },
    ],
  });

  if (isCancel(choice)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  return choice as DatabaseSetupChoice;
}

/** Get the dev command for a detected framework. */
function getDevCommand(root: string, framework?: DetectedFramework): string {
  if (!framework) {
    return formatProjectCommand(root, 'vite dev');
  }
  switch (framework.name) {
    case 'nuxt':
      return 'nuxt dev';
    case 'astro':
      return 'astro dev';
    default:
      return formatProjectCommand(root, 'vite dev');
  }
}

function getNodeVersionLine(root: string): string {
  if (existsSync(join(root, '.node-version'))) {
    return 'node-version-file: .node-version';
  }
  return 'node-version: lts/*';
}

function getWorkflowYaml(root: string, pm: ProjectState['packageManager']): string {
  const nodeVersion = getNodeVersionLine(root);
  switch (pm) {
    case 'pnpm':
      return `name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v5
      - uses: actions/setup-node@v6
        with:
          ${nodeVersion}
          cache: pnpm
      - run: pnpm install
      - run: pnpm void deploy
        env:
          VOID_TOKEN: \${{ secrets.VOID_TOKEN }}
`;
    case 'yarn':
      return `name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          ${nodeVersion}
          cache: yarn
      - run: yarn install --immutable
      - run: yarn void deploy
        env:
          VOID_TOKEN: \${{ secrets.VOID_TOKEN }}
`;
    case 'bun':
      return `name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bunx void deploy
        env:
          VOID_TOKEN: \${{ secrets.VOID_TOKEN }}
`;
    default:
      return `name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          ${nodeVersion}
          cache: npm
      - run: npm ci
      - run: npx void deploy
        env:
          VOID_TOKEN: \${{ secrets.VOID_TOKEN }}
`;
  }
}

function setupGithubActions(root: string, state: ProjectState): void {
  const workflowPath = join(root, '.github', 'workflows', 'deploy.yml');

  if (existsSync(workflowPath)) {
    log.warn('deploy.yml already exists, skipping');
    return;
  }

  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(workflowPath, getWorkflowYaml(root, state.packageManager));
  log.success('Created .github/workflows/deploy.yml');

  note(
    '1. Run: npx void auth token\n' +
      '2. In your repo → Settings → Secrets → Actions → New secret\n' +
      '3. Name: VOID_TOKEN, paste the token as value',
    'Add your deploy token as a GitHub secret',
  );
}

function writeFileIfMissing(root: string, filePath: string, content: string): void {
  const fullPath = join(root, filePath);
  if (existsSync(fullPath)) {
    return;
  }
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
  log.success(`Created ${filePath}`);
}

function ensureGitignore(root: string): void {
  const gitignorePath = join(root, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, SCAFFOLD_GITIGNORE_LINES.join('\n') + '\n');
    log.success('Created .gitignore');
    return;
  }

  const content = readFileSync(gitignorePath, 'utf-8');
  const existing = new Set(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const missing = SCAFFOLD_GITIGNORE_LINES.filter((line) => !existing.has(line));
  if (missing.length === 0) {
    return;
  }

  const separator = content.endsWith('\n') ? '' : '\n';
  writeFileSync(gitignorePath, content + separator + missing.join('\n') + '\n');
  log.success('Updated .gitignore with Void defaults');
}

function ensurePnpmBuiltDependencies(pkg: Record<string, any>): void {
  if (!pkg.pnpm || typeof pkg.pnpm !== 'object' || Array.isArray(pkg.pnpm)) {
    pkg.pnpm = {};
  }

  const onlyBuiltDependencies = Array.isArray(pkg.pnpm.onlyBuiltDependencies)
    ? pkg.pnpm.onlyBuiltDependencies.filter(
        (value: unknown): value is string => typeof value === 'string',
      )
    : [];

  for (const dependency of PNPM_ONLY_BUILT_DEPENDENCIES) {
    if (!onlyBuiltDependencies.includes(dependency)) {
      onlyBuiltDependencies.push(dependency);
    }
  }

  pkg.pnpm.onlyBuiltDependencies = onlyBuiltDependencies;
}

function installProjectDependencies(
  root: string,
  packageManager: ProjectState['packageManager'],
): void {
  log.step(`Installing dependencies with ${packageManager}`);

  const result = spawnSync(packageManager, ['install'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `${packageManager} install failed with exit code ${result.status ?? 'unknown'}`,
    );
  }

  log.success(`Installed dependencies with ${packageManager}`);
}

export function generateStarterMigration(
  root: string,
  starterMode: Exclude<ScaffoldStarterMode, 'static'>,
): void {
  const dialect = starterMode === 'postgresql' ? 'postgresql' : 'sqlite';
  const configPath = writeDrizzleConfig(
    root,
    dialect === 'postgresql' ? 'postgresql://dummy' : ':memory:',
    dialect,
  );

  log.step('Generating initial Drizzle migration');
  const result = spawnSync(process.execPath, [drizzleKitBin, 'generate', '--config', configPath], {
    cwd: root,
    stdio: 'pipe',
    encoding: 'utf-8',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error(
      ['Failed to generate the starter database migration.', ...(detail ? [detail] : [])].join(
        '\n\n',
      ),
    );
  }

  log.success('Generated initial Drizzle migration');
}

function scaffoldPagesApp(
  root: string,
  packageManager: ProjectState['packageManager'],
  framework: ScaffoldFramework,
  starterMode: ScaffoldStarterMode,
): boolean {
  const packageJsonPath = join(root, 'package.json');
  const template = createPagesStarterTemplate({
    framework,
    starterMode,
    voidPackageSpec: resolveScaffoldDependencySpec(root, 'void', getOwnVersion()),
    adapterPackageSpec: resolveScaffoldDependencySpec(
      root,
      SCAFFOLD_FRAMEWORKS[framework].adapterPackage,
      getOwnVersion(),
    ),
  });
  let pkg: Record<string, any> = {};

  if (existsSync(packageJsonPath)) {
    try {
      pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    } catch {
      throw new Error('Could not parse package.json in empty project');
    }
  }

  const fallbackName =
    basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-') || 'my-app';
  if (!pkg.name || typeof pkg.name !== 'string') {
    pkg.name = fallbackName;
  }
  if (pkg.private === undefined) {
    pkg.private = true;
  }
  if (!pkg.type) {
    pkg.type = 'module';
  }

  if (!pkg.scripts || typeof pkg.scripts !== 'object' || Array.isArray(pkg.scripts)) {
    pkg.scripts = {};
  }
  for (const [name, command] of Object.entries(template.scripts)) {
    if (!pkg.scripts[name]) {
      pkg.scripts[name] = command;
    }
  }

  if (
    !pkg.dependencies ||
    typeof pkg.dependencies !== 'object' ||
    Array.isArray(pkg.dependencies)
  ) {
    pkg.dependencies = {};
  }
  if (
    !pkg.devDependencies ||
    typeof pkg.devDependencies !== 'object' ||
    Array.isArray(pkg.devDependencies)
  ) {
    pkg.devDependencies = {};
  }

  let dependencyAdded = false;
  const ensureDependency = (
    group: 'dependencies' | 'devDependencies',
    name: string,
    fallbackVersion: string,
  ) => {
    const otherGroup = group === 'dependencies' ? 'devDependencies' : 'dependencies';
    const existing = pkg[group][name] ?? pkg[otherGroup][name];
    if (!pkg[group][name]) {
      pkg[group][name] = existing ?? fallbackVersion;
      dependencyAdded = true;
    }
    if (pkg[otherGroup][name]) {
      delete pkg[otherGroup][name];
      dependencyAdded = true;
    }
  };

  for (const [name, version] of Object.entries(template.dependencies)) {
    ensureDependency('dependencies', name, version);
  }
  for (const [name, version] of Object.entries(template.devDependencies)) {
    ensureDependency('devDependencies', name, version);
  }

  if (packageManager === 'pnpm') {
    ensurePnpmBuiltDependencies(pkg);
    if (!pkg.packageManager || typeof pkg.packageManager !== 'string') {
      pkg.packageManager = 'pnpm@10.33.0';
    }
  }

  writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n');
  log.success('Updated package.json with starter scripts and dependencies');

  for (const [filePath, content] of Object.entries(template.files)) {
    writeFileIfMissing(root, filePath, content);
  }

  ensureGitignore(root);
  if (starterMode !== 'static') {
    applyDatabaseDialect(root, starterMode);
  }

  if (starterMode === 'postgresql') {
    const devCommand = getDevCommand(root);
    note(
      `Add DATABASE_URL to .env.local before running \`${devCommand}\`.\n` +
        'Void uses that direct connection for local PostgreSQL development.',
      'PostgreSQL local dev',
    );
  }

  return dependencyAdded;
}

function scaffoldDemo(root: string): void {
  const devCommand = getDevCommand(root);

  // Schema only — the matching migration is generated by generateStarterMigration()
  // after dependencies are installed, so it's properly tracked in _journal.json.
  mkdirSync(join(root, 'db'), { recursive: true });
  writeFileSync(
    join(root, 'db', 'schema.ts'),
    `import { sql } from "void/db";
import { integer, sqliteTable, text } from "void/schema-d1";

export const posts = sqliteTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdAt: text("created_at").notNull().default(sql\`(datetime('now'))\`),
});
`,
  );
  log.success('Created db/schema.ts');

  // API route
  mkdirSync(join(root, 'routes', 'api'), { recursive: true });
  writeFileSync(
    join(root, 'routes', 'api', 'posts.ts'),
    `import { defineHandler } from "void";
import { db } from "void/db";
import { posts } from "@schema";

// GET /api/posts — returns all posts, fully typed from migration schema
export const GET = defineHandler(async () => {
  return db.select().from(posts);
});
`,
  );
  log.success('Created routes/api/posts.ts');
  ensureProjectTsconfig(root, undefined, true, true);

  // Frontend demo
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'demo.ts'),
    `import { fetch } from "void/client";

// Fully typed: response type is inferred from the GET handler's return type,
// which is derived from the migration schema. No manual types needed.
const posts = await fetch("/api/posts");

console.log(posts);
// posts[0].title  ← string (type-checked)
// posts[0].body   ← string (type-checked)
// posts[0].nope   ← TypeScript error
`,
  );
  log.success('Created src/demo.ts');

  note(
    'SQL migration → DB types → Route handler → Route types → Typed fetch\n\n' +
      `Run \`${devCommand}\` and open src/demo.ts to see the types in action.\n` +
      'Try changing the migration or handler — types update automatically.',
    'Type Safety Demo',
  );
}

interface AgentSetupSelection {
  instructionFilePath: 'CLAUDE.md' | 'AGENTS.md';
  agents: AgentConfig[];
}

function detectInstructionFilePath(root: string, agents: AgentConfig[]): 'CLAUDE.md' | 'AGENTS.md' {
  if (agents.some((a) => a.skillsDir === '.claude/skills')) {
    return 'CLAUDE.md';
  }
  if (existsSync(join(root, 'CLAUDE.md'))) {
    return 'CLAUDE.md';
  }
  if (existsSync(join(root, 'AGENTS.md'))) {
    return 'AGENTS.md';
  }
  return 'AGENTS.md';
}

async function pickAgentWhenUndetected(): Promise<AgentSetupSelection> {
  const choice = await select({
    message: 'Could not detect your coding agent. Which one are you using?',
    options: [
      { value: 'claude-code', label: 'Claude Code' },
      { value: 'cursor', label: 'Cursor' },
      { value: 'codex', label: 'Codex' },
      { value: 'gemini-cli', label: 'Gemini CLI' },
      { value: 'generic', label: 'Generic' },
    ],
  });
  if (isCancel(choice)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  if (choice === 'generic') {
    return {
      instructionFilePath: 'AGENTS.md',
      agents: [],
    };
  }

  const selected = getAgentById(choice);
  if (!selected) {
    return {
      instructionFilePath: 'AGENTS.md',
      agents: [],
    };
  }

  return {
    instructionFilePath: choice === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md',
    agents: [selected],
  };
}

async function resolveAgentSetup(root: string): Promise<AgentSetupSelection> {
  const detected = detectAgents(root);
  if (detected.length > 0) {
    return {
      instructionFilePath: detectInstructionFilePath(root, detected),
      agents: detected,
    };
  }
  return pickAgentWhenUndetected();
}

function readAgentPrompt(): string {
  return readFileSync(join(getPackageDir(), 'AGENT_PROMPT.md'), 'utf-8');
}

function getOwnVersion(): string {
  const pkg = JSON.parse(readFileSync(join(getPackageDir(), 'package.json'), 'utf-8'));
  return pkg.version;
}

const MARKER_OPEN_RE = /<!--injected-by-void-v([\d.]+)-->/;
const MARKER_CLOSE = '<!--/injected-by-void-->';
const MARKER_BLOCK_RE = /<!--injected-by-void-v[\d.]+-->\n[\s\S]*?<!--\/injected-by-void-->/;

function injectAgentBlock(root: string, filePath: string): void {
  const fullPath = join(root, filePath);
  const version = getOwnVersion();
  const promptContent = readAgentPrompt();
  const openMarker = `<!--injected-by-void-v${version}-->`;
  const block = `${openMarker}\n${promptContent}\n${MARKER_CLOSE}`;

  if (existsSync(fullPath)) {
    const existing = readFileSync(fullPath, 'utf-8');
    const match = existing.match(MARKER_OPEN_RE);
    if (match) {
      if (match[1] === version) {
        log.info(`${filePath} already has Void instructions (v${version})`);
        return;
      }
      // Replace existing block with updated version
      const updated = existing.replace(MARKER_BLOCK_RE, block);
      writeFileSync(fullPath, updated);
      log.success(`Updated Void instructions in ${filePath} (v${match[1]} → v${version})`);
    } else {
      // Append block to end of file
      const separator = existing.endsWith('\n') ? '\n' : '\n\n';
      writeFileSync(fullPath, existing + separator + block + '\n');
      log.success(`Added Void instructions to ${filePath}`);
    }
  } else {
    writeFileSync(fullPath, block + '\n');
    log.success(`Created ${filePath} with Void instructions`);
  }
}

function writeMcpConfigForTarget(root: string, target: McpConfigTarget): void {
  const fullPath = join(root, target.filePath);
  let existing: Record<string, any> = {};
  if (existsSync(fullPath)) {
    try {
      existing = JSON.parse(readFileSync(fullPath, 'utf-8'));
    } catch {
      // unparseable — start fresh
    }
  }

  if (!existing[target.rootKey]) {
    existing[target.rootKey] = {};
  }

  if (existing[target.rootKey]['void']) {
    log.info(`${target.filePath} already has void MCP config`);
    return;
  }

  existing[target.rootKey]['void'] = {
    command: 'npx',
    args: ['void', 'mcp'],
    ...target.extraFields,
  };

  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, JSON.stringify(existing, null, 2) + '\n');
  log.success(`Added void MCP server to ${target.filePath}`);
}

function pickMcpTarget(root: string, targets: McpConfigTarget[]): McpConfigTarget {
  if (targets.length === 1) {
    return targets[0];
  }
  const existingTargets = targets.filter((t) => existsSync(join(root, t.filePath)));
  if (existingTargets.length > 0) {
    return existingTargets[0];
  }
  return targets[0];
}

function setupMcpConfig(root: string, selectedAgents: AgentConfig[]): void {
  const mcpAgents: { agent: AgentConfig; targets: McpConfigTarget[] }[] = [];
  const hintAgents: { agent: AgentConfig; hint: string }[] = [];

  for (const agent of selectedAgents) {
    if (agent.mcpConfig) {
      mcpAgents.push({ agent, targets: agent.mcpConfig });
    } else if (agent.mcpHint) {
      hintAgents.push({ agent, hint: agent.mcpHint });
    }
  }

  if (selectedAgents.length === 0) {
    note(
      JSON.stringify(
        {
          void: {
            command: 'npx',
            args: ['void', 'mcp'],
          },
        },
        null,
        2,
      ),
      'Add this MCP server config to your agent',
    );
    return;
  }

  // Print hints for agents without project-level config
  for (const { agent, hint } of hintAgents) {
    log.info(`${agent.displayName}: ${hint}`);
  }

  // Write config for agents with project-level support
  for (const { agent, targets } of mcpAgents) {
    const target = pickMcpTarget(root, targets);
    log.info(`${agent.displayName} MCP target: ${target.filePath}`);
    writeMcpConfigForTarget(root, target);
  }
}

export async function runInitCommand(root: string, initArgs?: InitArgs): Promise<void> {
  console.log();
  intro(cliTitle('init'));

  const targeted = Boolean(initArgs && (initArgs.tsconfig || initArgs.github || initArgs.agents));
  const framework = detectFramework(root);
  const preScaffoldState = detectProjectState(root);
  const detectedPagesFramework = detectPagesFramework(root);
  let scaffoldedPagesFramework: ScaffoldFramework | undefined;
  let scaffoldedStarterMode: Exclude<ScaffoldStarterMode, 'static'> | undefined;
  let didScaffoldStarter = false;
  let didScaffoldDemo = false;
  let scaffoldAddedDependencies = false;

  if (framework) {
    log.info(`Detected ${framework.name} framework`);
  }

  if (!targeted && !framework && isScaffoldableEmptyProject(root)) {
    log.info('Empty project detected. Scaffolding a Pages starter...');
    if (detectedPagesFramework) {
      scaffoldedPagesFramework = detectedPagesFramework;
      log.info(
        `Detected ${SCAFFOLD_FRAMEWORKS[detectedPagesFramework].label} adapter in package.json`,
      );
    } else {
      scaffoldedPagesFramework = await promptScaffoldFramework();
    }
    const starterMode = await promptStarterMode();
    scaffoldAddedDependencies = scaffoldPagesApp(
      root,
      preScaffoldState.packageManager,
      scaffoldedPagesFramework,
      starterMode,
    );
    if (starterMode !== 'static') {
      scaffoldedStarterMode = starterMode;
    }
    didScaffoldStarter = true;
  }

  const state = detectProjectState(root);
  const pagesFramework = scaffoldedPagesFramework ?? detectPagesFramework(root);

  // Step 1: TypeScript / tsconfig
  if (!targeted || initArgs?.tsconfig) {
    state.typescriptWanted = true;
    setupTsconfig(root, state, pagesFramework);
  }

  // Generate .void/tsconfig.json so the root tsconfig can extend it
  if (state.typescriptWanted) {
    const hasSchema = hasDrizzleSchema(root);
    ensureProjectTsconfig(root, undefined, hasSchema, hasSchema);
  }

  ensureGitignore(root);

  // Step 2: Wrangler config (class B/C meta-frameworks)
  if (framework) {
    setupWranglerConfig(root, framework);
  }

  if (!targeted) {
    ensureVoidWorkerCompatibilityDate(root);
  }

  // Step 3: Database dialect
  if (!targeted && !didScaffoldStarter) {
    applyDatabaseSetup(root, await promptDatabaseSetup(root));
  }

  // Steps 4–6: Agent instructions, skills, MCP config
  if (!targeted || initArgs?.agents) {
    const agentSetup = await resolveAgentSetup(root);

    // Step 4: Agent instructions
    injectAgentBlock(root, agentSetup.instructionFilePath);

    // Step 5: Link skills
    if (agentSetup.agents.length > 0) {
      const { linkSkillsForSpecificAgents } = await import('./skills');
      linkSkillsForSpecificAgents(root, agentSetup.agents);
    } else {
      log.info('Skills linking skipped for generic agent setup');
    }

    // Step 6: MCP config
    setupMcpConfig(root, agentSetup.agents);
  }

  // Step 7: Demo code (only in full interactive flow, not for meta-frameworks)
  if (!targeted && !framework) {
    if (didScaffoldStarter || state.hasRoutes || state.hasMigrations || state.hasPages) {
      log.info('Project already has pages, routes, or migrations, skipping demo');
    } else if (!state.typescriptWanted) {
      // Demo requires TypeScript for the type pipeline
    } else {
      const scaffold = await confirm({
        message: 'Scaffold demo code? (migration + API route + frontend fetch)',
      });
      if (isCancel(scaffold)) {
        cancel('Setup cancelled.');
        process.exit(0);
      }
      if (scaffold) {
        scaffoldDemo(root);
        didScaffoldDemo = true;
      }
    }
  }

  // Step 8: GitHub Actions
  if (!targeted || initArgs?.github) {
    const deployYmlPath = join(root, '.github', 'workflows', 'deploy.yml');
    if (existsSync(deployYmlPath)) {
      log.warn('deploy.yml already exists, skipping');
    } else if (targeted) {
      // --github flag: run directly without prompting
      setupGithubActions(root, state);
    } else {
      const setupGha = await confirm({ message: 'Set up GitHub Actions deployment?' });
      if (isCancel(setupGha)) {
        cancel('Setup cancelled.');
        process.exit(0);
      }
      if (setupGha) {
        setupGithubActions(root, state);
      }
    }
  }

  if (!targeted) {
    await maybeSetupDeployProject(root);
  }

  if (scaffoldAddedDependencies) {
    installProjectDependencies(root, state.packageManager);
  }
  const starterMigrationDialect = scaffoldedStarterMode ?? (didScaffoldDemo ? 'sqlite' : undefined);
  if (starterMigrationDialect) {
    generateStarterMigration(root, starterMigrationDialect);
  }

  outro(`Run \`${getDevCommand(root, framework)}\` to start developing`);
}
