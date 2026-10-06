import { spawnSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { PlatformDiscoveryDocument } from '@void/platform';
import {
  outro,
  log,
  confirm,
  isCancel,
  cancel,
  select,
  text,
} from '@voidzero-dev/vite-plus-prompts';
import { parse, type ParseError } from 'jsonc-parser';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'pathslash';
import { materializeCloudflareConfig } from '../cloudflare-config.ts';
import { createProjectTsconfig, ensureProjectTsconfig } from '../codegen/project-tsconfig.ts';
import { TYPED_CONFIG_FILE } from '../config-loader.ts';
import { canRewriteVoidProjectConfig, writeVoidProjectConfig } from '../config-write.ts';
import { getDatabaseDialect, readConfig, type DatabaseDialect } from '../config.ts';
import { writeDrizzleConfig } from '../drizzle/config.ts';
import { detectFramework, type DetectedFramework } from '../plugin-inference.ts';
import { readProjectPaths } from '../project-paths.ts';
import { detectAgents, getPackageDir } from './agents.ts';
import { connectCloudflare } from './cloudflare-connect.ts';
import { maybeSetupDeployProject } from './deploy-setup.ts';
import { maybeScaffoldEnvTs } from './env-scaffold.ts';
import { migrateFrameworkAdapterPaths } from './framework-config-migrate.ts';
import { initialCommitCommand, setupGit } from './init-git.ts';
import { migrateLegacyVoidConfig } from './migrate.ts';
import { note } from './output.ts';
import { discoverPlatform, saveDiscoveredPlatform } from './platform-cmd.ts';
import { formatProjectCommand } from './preset.ts';
import {
  readDeploymentPlatform,
  readProjectConfig,
  writeDeploymentPlatform,
  type DeploymentPlatform,
} from './project.ts';
import {
  createPagesStarterTemplate,
  detectScaffoldFrameworkFromDependencies,
  getScaffoldTsconfigCompilerOptions,
  SCAFFOLD_BASE_DEV_DEPENDENCIES,
  SCAFFOLD_FRAMEWORKS,
  SCAFFOLD_FRAMEWORK_OPTIONS,
  SCAFFOLD_GITIGNORE_LINES,
  SCAFFOLD_TOOLCHAIN_OPTIONS,
  type ScaffoldFramework,
  type ScaffoldStarterMode,
  type ScaffoldToolchain,
} from './template.ts';
import { patchViteConfigWithVoidPlugin } from './vite-config-patch.ts';
import { LATEST_KNOWN_COMPAT_DATE, writeProvisionedWranglerConfig } from './wrangler.ts';
import {
  buildDrizzleKitSpawnEnv,
  findInstalledYarnPnpRuntime,
  hasLocalLockfile,
} from './yarn-pnp.ts';

export type InitArgs = {
  tsconfig: boolean;
  github: boolean;
  agents: boolean;
  git?: boolean;
};

export function parseInitArgs(args: Array<string>): InitArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      options: {
        tsconfig: { type: 'boolean' },
        github: { type: 'boolean' },
        agents: { type: 'boolean' },
        git: { type: 'boolean' },
      },
      allowNegative: true,
      strict: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`init: ${message}.`);
  }

  return {
    tsconfig: parsed.values.tsconfig === true,
    github: parsed.values.github === true,
    agents: parsed.values.agents === true,
    git: parsed.values.git as boolean | undefined,
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
  '.void',
  '.wrangler',
  'node_modules',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'tsconfig.json',
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

const PNPM_ALLOWED_BUILDS = ['esbuild', 'sharp', 'workerd'] as const;
const drizzleKitBin = join(fileURLToPath(import.meta.resolve('drizzle-kit')), '..', 'bin.cjs');

// Dependencies/scripts that can be left behind by a Void Pages starter after
// the user deletes app files and runs `void init` again. These keep that retry
// in the greenfield starter path instead of the existing-project patch path.
const EMPTY_PROJECT_ALLOWED_PACKAGES = new Set([
  'void',
  'hono',
  'vite',
  'vite-plus',
  'typescript',
  '@rolldown/plugin-babel',
  '@vitejs/plugin-react',
  'babel-plugin-react-compiler',
  'oxc-transform-react',
  '@types/react',
  '@types/react-dom',
  'react',
  'react-dom',
  'vue',
  'svelte',
  'solid-js',
  '@void/react',
  '@void/vue',
  '@void/svelte',
  '@void/solid',
]);

// A package with only `void` and/or an adapter can still be a preinstall shape
// (`pnpm add -D void @void/svelte` before init). Once starter runtime/tooling
// packages like `svelte` or `vite-plus` are present, require an adapter too so
// we only accept manifests that look like a previous Void Pages starter.
const EMPTY_PROJECT_ALLOWED_ADAPTER_PACKAGES = new Set([
  '@void/react',
  '@void/vue',
  '@void/svelte',
  '@void/solid',
]);
const EMPTY_PROJECT_BASE_PACKAGES = new Set([
  'void',
  '@void/react',
  '@void/vue',
  '@void/svelte',
  '@void/solid',
]);

// Known starter scripts are allowed for scaffold detection and are replaced
// with the newly selected toolchain's commands during scaffoldPagesApp().
// Custom scripts make the package an existing project instead.
const EMPTY_PROJECT_ALLOWED_SCRIPTS: Record<string, Set<string> | undefined> = {
  test: undefined,
  dev: new Set(['vite', 'vp dev']),
  build: new Set(['vite build', 'vp build']),
  preview: new Set(['vite preview', 'vp preview']),
};
const EMPTY_PROJECT_STARTER_SCRIPT_COMMANDS = new Set(
  Object.values(EMPTY_PROJECT_ALLOWED_SCRIPTS).flatMap((commands) =>
    commands ? Array.from(commands) : [],
  ),
);

function isStarterScriptCommand(value: unknown): boolean {
  return typeof value === 'string' && EMPTY_PROJECT_STARTER_SCRIPT_COMMANDS.has(value);
}

function hasOnlyVoidStarterDependencies(depNames: Array<string>): boolean {
  if (depNames.some((dep) => !EMPTY_PROJECT_ALLOWED_PACKAGES.has(dep))) {
    return false;
  }
  const hasStarterDependency = depNames.some((dep) => !EMPTY_PROJECT_BASE_PACKAGES.has(dep));
  const hasPagesAdapter = depNames.some((dep) => EMPTY_PROJECT_ALLOWED_ADAPTER_PACKAGES.has(dep));
  return !hasStarterDependency || hasPagesAdapter;
}

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
type InitLocationChoice = 'subfolder' | 'current';
type JsonObject = Record<string, unknown>;
type TsconfigInheritancePatch = {
  files: Array<string>;
  paths: Record<string, Array<string>>;
};

function asRecord(value: unknown): JsonObject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

function parseJsoncFile(path: string): JsonObject | null {
  const errors: Array<ParseError> = [];
  const parsed = asRecord(parse(readFileSync(path, 'utf-8'), errors));
  return errors.length === 0 ? parsed : null;
}

function uniqueStrings(values: Array<string>): Array<string> {
  return Array.from(new Set(values));
}

function normalizeRelativePath(fromDir: string, toPath: string): string {
  const rel = relative(fromDir, toPath).replaceAll('\\', '/');
  return rel === '..' || rel.startsWith('../') || rel.startsWith('./') ? rel : `./${rel}`;
}

function getOwnConfigBaseUrlDir(config: JsonObject, configDir: string): string | null {
  const compilerOptions = asRecord(config.compilerOptions);
  return compilerOptions && typeof compilerOptions.baseUrl === 'string'
    ? resolve(configDir, compilerOptions.baseUrl)
    : null;
}

function readExtends(config: JsonObject): Array<string> {
  return typeof config.extends === 'string'
    ? [config.extends]
    : Array.isArray(config.extends)
      ? config.extends.filter((value): value is string => typeof value === 'string')
      : [];
}

function getEffectiveConfigBaseUrlDir(
  config: JsonObject,
  configPath: string,
  seen: Set<string>,
): string | null {
  if (seen.has(configPath)) {
    return null;
  }
  seen.add(configPath);

  const configDir = dirname(configPath);
  const ownBaseUrl = getOwnConfigBaseUrlDir(config, configDir);
  if (ownBaseUrl) {
    return ownBaseUrl;
  }

  const extendsValues = readExtends(config);

  let inheritedBaseUrl: string | null = null;
  for (const extendsValue of extendsValues) {
    const extendedPath = resolveExtendedTsconfig(configPath, extendsValue);
    if (!extendedPath || !existsSync(extendedPath)) {
      continue;
    }

    const extendedConfig = parseJsoncFile(extendedPath);
    if (!extendedConfig) {
      continue;
    }

    inheritedBaseUrl =
      getEffectiveConfigBaseUrlDir(extendedConfig, extendedPath, seen) ?? inheritedBaseUrl;
  }

  return inheritedBaseUrl;
}

function effectiveConfigPathBaseDir(config: JsonObject, configPath: string): string {
  return getEffectiveConfigBaseUrlDir(config, configPath, new Set()) ?? dirname(configPath);
}

function convertConfigFileEntry(value: string, configDir: string, root: string): string {
  if (isAbsolute(value)) {
    return normalizeRelativePath(root, value);
  }
  return normalizeRelativePath(root, resolve(configDir, value));
}

function convertPathTarget(value: string, fromBaseDir: string, toBaseDir: string): string {
  if (isAbsolute(value)) {
    return normalizeRelativePath(toBaseDir, value);
  }
  return normalizeRelativePath(toBaseDir, resolve(fromBaseDir, value));
}

function mergePathMaps(
  target: Record<string, Array<string>>,
  source: Record<string, Array<string>>,
): void {
  for (const [key, values] of Object.entries(source)) {
    target[key] = values;
  }
}

function readStringArray(value: unknown): Array<string> {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function readPaths(value: unknown): Record<string, Array<string>> {
  const paths = asRecord(value);
  if (!paths) {
    return {};
  }

  const result: Record<string, Array<string>> = {};
  for (const [key, values] of Object.entries(paths)) {
    const stringValues = readStringArray(values);
    if (stringValues.length > 0) {
      result[key] = stringValues;
    }
  }
  return result;
}

function resolveExtendedTsconfig(fromConfigPath: string, specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const resolved = resolve(dirname(fromConfigPath), specifier);
    return resolved.endsWith('.json') ? resolved : `${resolved}.json`;
  }

  try {
    return createRequire(fromConfigPath).resolve(specifier);
  } catch {
    try {
      return createRequire(fromConfigPath).resolve(`${specifier}.json`);
    } catch {
      return null;
    }
  }
}

function collectTsconfigPatchFromConfig(
  config: JsonObject,
  configPath: string,
  root: string,
  outputBaseDir: string,
  seen: Set<string>,
): TsconfigInheritancePatch {
  const patch: TsconfigInheritancePatch = { files: [], paths: {} };

  if (seen.has(configPath)) {
    return patch;
  }
  seen.add(configPath);

  const extendsValues = readExtends(config);

  const hasOwnFiles = Array.isArray(config.files);
  const compilerOptions = asRecord(config.compilerOptions);
  const hasOwnPaths = asRecord(compilerOptions?.paths) !== null;

  for (const extendsValue of extendsValues) {
    const extendedPath = resolveExtendedTsconfig(configPath, extendsValue);
    if (!extendedPath || !existsSync(extendedPath)) {
      continue;
    }

    const extendedConfig = parseJsoncFile(extendedPath);
    if (!extendedConfig) {
      continue;
    }

    const extendedPatch = collectTsconfigPatchFromConfig(
      extendedConfig,
      extendedPath,
      root,
      outputBaseDir,
      seen,
    );
    if (!hasOwnFiles) {
      patch.files.push(...extendedPatch.files);
    }
    if (!hasOwnPaths) {
      mergePathMaps(patch.paths, extendedPatch.paths);
    }
  }

  const configDir = dirname(configPath);
  if (hasOwnFiles) {
    patch.files.push(
      ...readStringArray(config.files).map((entry) =>
        convertConfigFileEntry(entry, configDir, root),
      ),
    );
  }

  if (hasOwnPaths) {
    const paths = readPaths(compilerOptions?.paths);
    const pathBaseDir = effectiveConfigPathBaseDir(config, configPath);
    const convertedPaths: Record<string, Array<string>> = {};
    for (const [key, values] of Object.entries(paths)) {
      convertedPaths[key] = values.map((value) =>
        convertPathTarget(value, pathBaseDir, outputBaseDir),
      );
    }
    mergePathMaps(patch.paths, convertedPaths);
  }

  return patch;
}

function createVoidTsconfigPatch(root: string, outputBaseDir: string): TsconfigInheritancePatch {
  const hasSchema = hasDrizzleSchema(root);
  const voidConfig = createProjectTsconfig(root, undefined, hasSchema, hasSchema);
  return collectTsconfigPatchFromConfig(
    voidConfig as unknown as JsonObject,
    join(root, '.void', 'tsconfig.json'),
    root,
    outputBaseDir,
    new Set(),
  );
}

function hasTopLevelYamlKey(yaml: string, key: string): boolean {
  const keyPattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
  return yaml.split(/\r?\n/).some((rawLine) => {
    const line = stripYamlLineComment(rawLine);
    return keyPattern.test(line);
  });
}

function isEmptyProjectAllowedPnpmWorkspaceFile(root: string): boolean {
  try {
    const yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf-8');
    return !hasTopLevelYamlKey(yaml, 'packages');
  } catch {
    return false;
  }
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
    if (entry.name === 'pnpm-workspace.yaml' && isEmptyProjectAllowedPnpmWorkspaceFile(root)) {
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
  if (!hasOnlyVoidStarterDependencies(Object.keys(deps))) {
    return false;
  }

  const scripts = asRecord(pkg.scripts) ?? {};
  for (const [name, command] of Object.entries(scripts)) {
    if (!(name in EMPTY_PROJECT_ALLOWED_SCRIPTS)) {
      return false;
    }
    const allowed = EMPTY_PROJECT_ALLOWED_SCRIPTS[name];
    if (allowed === undefined) {
      continue;
    }
    if (typeof command !== 'string' || !allowed.has(command)) {
      return false;
    }
  }

  return true;
}

function shouldPromptForInitLocation(root: string): boolean {
  if (isScaffoldableEmptyProject(root)) {
    return false;
  }
  if (existsSync(join(root, 'package.json'))) {
    return false;
  }
  if (existsSync(join(root, VOID_CONFIG_FILE)) || existsSync(join(root, TYPED_CONFIG_FILE))) {
    return false;
  }
  return findViteConfig(root) === undefined;
}

function validateSubfolderName(root: string, value: string | undefined): string | undefined {
  const name = value?.trim() ?? '';
  if (!name) {
    return 'Enter a folder name.';
  }
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    return 'Enter a single folder name, not a path.';
  }
  if (existsSync(join(root, name))) {
    return 'That folder already exists.';
  }
  return undefined;
}

async function resolveInitRoot(root: string): Promise<string> {
  if (!shouldPromptForInitLocation(root)) {
    return root;
  }

  const choice = await select({
    message: 'This folder is not empty. Where should Void initialize?',
    initialValue: 'subfolder',
    options: [
      {
        value: 'subfolder',
        label: 'Create a new subfolder',
        hint: 'Scaffold a new app inside this directory.',
      },
      {
        value: 'current',
        label: 'Continue here',
        hint: 'Add package.json, vite.config.ts, and Void files to this directory.',
      },
    ],
  });

  if (isCancel(choice)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  if ((choice as InitLocationChoice) === 'current') {
    return root;
  }

  const defaultFolder = 'my-void-app';
  const folder = await text({
    message: 'New project folder name:',
    placeholder: defaultFolder,
    defaultValue: defaultFolder,
    validate: (value) => validateSubfolderName(root, value || defaultFolder),
  });

  if (isCancel(folder) || typeof folder === 'symbol') {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  const nextRoot = join(root, folder.trim());
  mkdirSync(nextRoot, { recursive: true });
  log.info(`Scaffolding in ${nextRoot}`);
  return nextRoot;
}

type ProjectState = {
  hasTypescript: boolean;
  hasTsconfig: boolean;
  hasGithubWorkflows: boolean;
  hasRoutes: boolean;
  hasMigrations: boolean;
  hasPages: boolean;
  packageManager: 'pnpm' | 'yarn' | 'bun' | 'npm';
  typescriptWanted: boolean;
};

function parsePackageManagerField(pkg: unknown): ProjectState['packageManager'] | undefined {
  if (!pkg || typeof pkg !== 'object') {
    return undefined;
  }
  const raw = (pkg as { packageManager?: unknown }).packageManager;
  if (typeof raw !== 'string') {
    return undefined;
  }
  // Corepack spec: "name@version[+sha.<hash>]". Take the portion before the
  // first `@` and trim whitespace; reject anything that isn't a known PM name.
  const name = raw.split('@', 1)[0]?.trim();
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') {
    return name;
  }
  return undefined;
}

/**
 * Returns `true` when a project should be treated as pnpm-managed for
 * purposes of installing build-script allowlists and picking a
 * `workspace:` rewrite strategy. We honor BOTH local signals — a committed
 * `pnpm-lock.yaml`, a local `pnpm-workspace.yaml`, or a Corepack
 * `packageManager: pnpm` pin in `package.json` — AND the same signals on
 * any ancestor workspace root.
 *
 * Ancestor walking matters for pnpm workspace subpackages: pnpm writes the
 * lockfile at the workspace root, not per-package, and many subpackages
 * omit their own `packageManager` field in favor of the workspace root's.
 * A subpackage with a `workspace:*` dep in its `package.json` but no local
 * pnpm markers is still pnpm-managed if the enclosing workspace root has
 * `pnpm-workspace.yaml`, a `pnpm-lock.yaml`, or `packageManager: pnpm@...`.
 *
 * Local non-pnpm signals MUST outrank the ancestor walk. A bun
 * or yarn subproject nested under a pnpm workspace ancestor is still
 * bun/yarn — its local `bun.lockb` / `yarn.lock` / `package-lock.json` or
 * a local Corepack pin for bun/yarn/npm proves the ancestor's pnpm shape
 * does not govern this subpackage. `detectProjectState` would pick
 * bun/yarn for such a project and try to install with that manager, so
 * the pnpm check must not inherit ancestor workspace state too eagerly.
 */
function isPnpmProject(root: string, pkg: JsonObject): boolean {
  // 1. Strong local pnpm signals — immediate true.
  if (existsSync(join(root, 'pnpm-lock.yaml'))) {
    return true;
  }
  if (existsSync(join(root, 'pnpm-workspace.yaml'))) {
    return true;
  }
  const localPm = parsePackageManagerField(pkg);
  if (localPm === 'pnpm') {
    return true;
  }

  // 2. Strong local non-pnpm signals — refuse to walk ancestors. A local
  //    lockfile or Corepack pin for a different manager means this
  //    package is governed by that manager, even if an ancestor is a
  //    pnpm workspace root.
  if (localPm === 'bun' || localPm === 'yarn' || localPm === 'npm') {
    return false;
  }
  if (hasLocalLockfile(root)) {
    return false;
  }

  // 3. Pristine subpackage with no local package-manager markers at
  //    all — only now is it safe to walk ancestors looking for a pnpm
  //    workspace root.
  return hasAncestorPnpmMarkers(root);
}

/**
 * Returns `true` when `start` is a declared member of an ancestor pnpm
 * workspace. Used to detect pnpm workspace subpackages whose enclosing
 * workspace root is pnpm-managed even when the subpackage has no local
 * pnpm signals.
 *
 * An ancestor `pnpm-workspace.yaml` / `pnpm-lock.yaml` /
 * Corepack pnpm pin alone is NOT proof that `start` is governed by
 * that repo's pnpm install. A scratch app nested under a pnpm
 * monorepo is a separate project when its path doesn't match the
 * workspace globs; treating it as a member would make
 * `ensureVoidDependency` / `scaffoldPagesApp` disagree with the local
 * install, which uses the standalone fallback path.
 *
 * Delegate workspace membership to `findWorkspaceRoot` +
 * `isWorkspaceSubpackage` — the same check used by the
 * workspace-subpackage skip path in `runInitCommand` — so the two
 * paths can't disagree.
 */
function hasAncestorPnpmMarkers(start: string): boolean {
  const workspaceRoot = findWorkspaceRoot(start);
  if (workspaceRoot === undefined) {
    return false;
  }
  if (!isWorkspaceSubpackage(workspaceRoot, start)) {
    return false;
  }
  // We're a declared member. Confirm the containing workspace is
  // pnpm-shaped — a yarn/npm/bun workspace root with a matching glob
  // should not push us onto the pnpm branch.
  if (existsSync(join(workspaceRoot, 'pnpm-workspace.yaml'))) {
    return true;
  }
  if (existsSync(join(workspaceRoot, 'pnpm-lock.yaml'))) {
    return true;
  }
  const pkgPath = join(workspaceRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (parsePackageManagerField(pkg) === 'pnpm') {
        return true;
      }
    } catch {
      // unreadable workspace-root package.json — treat as "not pnpm"
    }
  }
  return false;
}

/**
 * Walk up from `start` checking each ancestor directory for a
 * `node_modules/void/package.json`. Mirrors Node's module resolution
 * algorithm for the `void` package name — returns true as soon as any
 * ancestor has `void` installed, false only when the entire chain is
 * empty. Used by the demo install gate so workspace subpackages whose
 * `void` is hoisted at the workspace root are detected as already
 * installed and we don't trigger a spurious subpackage install.
 *
 * PnP rationale: in a Yarn Berry PnP workspace, dependencies resolve
 * via `.pnp.cjs` at the workspace root and there is no `node_modules`
 * tree — not in the subpackage, not in ancestors. By the time we call
 * this, `scaffoldDemo`/`ensureVoidDependency` has added `void` to the
 * subpackage's `package.json` (or verified it was already there), and
 * under PnP the workspace-root install is what wires up resolution.
 *
 * A committed-but-unfetched `.pnp.cjs` is NOT proof that
 * `yarn install` has run. Yarn Berry repos commonly commit `.pnp.cjs`
 * but gitignore `.yarn/cache/*.zip` (zero-install is opt-in), so a
 * fresh clone has the runtime file on disk while the archives it
 * points at are missing. The stricter `findInstalledYarnPnpRuntime`
 * also requires a post-install marker next to the runtime
 * (`.yarn/install-state.gz` or a populated `.yarn/cache`). Without it,
 * we fall through and return false so the caller triggers the install
 * step before attempting to spawn drizzle-kit.
 */
export function isVoidResolvableFrom(start: string): boolean {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, 'node_modules', 'void', 'package.json'))) {
      return true;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  // PnP supersedes node_modules resolution. If any ancestor has the
  // PnP runtime files AND the post-install marker in the same
  // directory, void MAY resolve through PnP at runtime.
  //
  // An installed PnP runtime still isn't proof that `void`
  // is currently on the dependency graph. Branch switches and edits
  // to package.json can leave stale PnP data where void has been
  // removed; `.pnp.cjs` still exists but the current install target
  // has no void entry. Spawn a tiny probe under the PnP loaders to
  // verify resolution succeeds in the same env drizzle-kit will
  // later run under.
  //
  // The probe must match the shape of the installed PnP
  // runtime. When only `.pnp.loader.mjs` is present, `--require` is
  // NOT injected by `buildDrizzleKitSpawnEnv` — only
  // `--experimental-loader` is — and Node's CJS `require.resolve`
  // does not consult the ESM loader chain, so a CJS probe returns
  // `MODULE_NOT_FOUND` even when `void` IS resolvable via the loader.
  // Branch the probe shape on `.pnp.cjs` presence: CJS probe when the
  // CJS shim is loaded, ESM probe (`import.meta.resolve`) when only
  // the loader is loaded. `import.meta.resolve` goes through the
  // PnP loader's `resolve` hook and throws synchronously when the
  // specifier cannot be resolved, which surfaces as a non-zero exit.
  const installed = findInstalledYarnPnpRuntime(start);
  if (installed !== undefined) {
    const probeArgs = installed.pnpCjs
      ? ['-e', "require.resolve('void')"]
      : ['--input-type=module', '-e', "import.meta.resolve('void')"];
    const probe = spawnSync(process.execPath, probeArgs, {
      cwd: start,
      stdio: 'ignore',
      shell: process.platform === 'win32',
      env: buildDrizzleKitSpawnEnv(start),
    });
    return !probe.error && probe.status === 0;
  }
  return false;
}

/**
 * Walks ancestors from `start` looking for workspace-root markers: a
 * `pnpm-workspace.yaml` next to a `package.json`, or a `package.json`
 * whose top-level `workspaces` field exists (array or object). Returns
 * the discovered workspace root path if `start` is a subpackage inside
 * such a workspace, or `undefined` when it is not. Stops at the
 * filesystem root. Skips `start` itself — a root with its own
 * `workspaces` field is its own root, not a subpackage.
 */
function findWorkspaceRoot(start: string): string | undefined {
  let dir = dirname(start);
  while (true) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
        if (pkg && typeof pkg === 'object' && 'workspaces' in pkg) {
          return dir;
        }
      } catch {
        // unreadable parent package.json — fall through and keep walking
      }
    }
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * Read the declared workspace-member glob patterns from a workspace root.
 * Supports:
 *   - `pnpm-workspace.yaml` — extracts patterns under the top-level
 *     `packages:` key via a regex matcher (no `js-yaml` dep). Only the
 *     `packages:` key is used; pnpm-specific keys like `catalog:` are
 *     ignored.
 *   - `package.json#workspaces` — either an array of patterns or a
 *     `{ packages: [...] }` object form (npm/yarn/bun convention).
 *
 * Returns an empty array if no patterns are declared or parsing fails —
 * callers should treat that as "can't verify membership" and fall back
 * to the fresh-clone install path.
 */
function readWorkspacePatterns(workspaceRoot: string): Array<string> {
  const pnpmWorkspacePath = join(workspaceRoot, 'pnpm-workspace.yaml');
  if (existsSync(pnpmWorkspacePath)) {
    try {
      const yaml = readFileSync(pnpmWorkspacePath, 'utf-8');
      return extractPnpmWorkspacePackages(yaml);
    } catch {
      return [];
    }
  }
  const pkgPath = join(workspaceRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
      const workspaces = (pkg as { workspaces?: unknown }).workspaces;
      if (Array.isArray(workspaces)) {
        return workspaces.filter((x): x is string => typeof x === 'string');
      }
      if (workspaces && typeof workspaces === 'object') {
        const packages = (workspaces as { packages?: unknown }).packages;
        if (Array.isArray(packages)) {
          return packages.filter((x): x is string => typeof x === 'string');
        }
      }
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Strip a trailing YAML line comment from a raw line while preserving
 * `#` characters that live inside single- or double-quoted scalars.
 * YAML treats `#` as a comment marker only when it is preceded by
 * whitespace (or is the first column) AND it is not inside a quoted
 * scalar. Flow-style inline quoting is handled by a plain state machine
 * — no escape sequence support, because real-world workspace globs
 * never contain escaped quotes. A naive `/\s+#.*$/` strip would
 * truncate quoted values like `- "path #hash/*"`.
 */
function stripYamlLineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '#' && i > 0 && /\s/.test(line[i - 1])) {
      return line.slice(0, i).replace(/\s+$/, '');
    }
  }
  return line;
}

/**
 * Minimal YAML extractor for the `packages:` key of a
 * `pnpm-workspace.yaml`. Supports both the block-style form:
 *
 *   packages:
 *     - 'packages/*'
 *     - "apps/*"
 *     - docs
 *
 * and the flow-style (inline) form:
 *
 *   packages: ['packages/*', "apps/*"]
 *   packages: [packages/*]
 *
 * Anything else (other top-level keys, comments, nested blocks) is
 * ignored. This intentionally does NOT pull in `js-yaml` — the
 * surface area we need is tiny and the real YAML we see in practice
 * uses one of these two shapes.
 */
export function extractPnpmWorkspacePackages(yaml: string): Array<string> {
  const lines = yaml.split(/\r?\n/);
  const patterns: Array<string> = [];
  let inPackages = false;
  for (const rawLine of lines) {
    const line = stripYamlLineComment(rawLine);

    // Flow-style: `packages: [<items>]` on a single line. Values may
    // be quoted (`'...'` or `"..."`) or unquoted. Whitespace around
    // brackets and commas is tolerated. Escaped quotes inside the
    // flow value are not supported because no real-world workspace
    // pattern uses them.
    const inlineMatch = line.match(/^\s*packages\s*:\s*\[(.*)\]\s*$/);
    if (inlineMatch) {
      const inner = inlineMatch[1];
      const items = inner.match(/(['"])(?:(?!\1).)*\1|[^,\s]+/g) ?? [];
      for (const raw of items) {
        const unquoted = raw.trim().replace(/^(['"])(.*)\1$/, '$2');
        if (unquoted) {
          patterns.push(unquoted);
        }
      }
      // Inline form is self-contained — end any in-progress block.
      inPackages = false;
      continue;
    }

    if (/^\s*packages\s*:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) {
      continue;
    }
    // Any other top-level key ends the `packages:` block.
    if (/^[A-Za-z_][\w-]*\s*:\s*(?:\S.*)?$/.test(line) && !/^\s/.test(line)) {
      inPackages = false;
      continue;
    }
    const m = line.match(/^\s*-\s*(['"]?)([^'"\s][^'"]*?)\1\s*$/);
    if (m) {
      patterns.push(m[2]);
    }
  }
  return patterns;
}

/**
 * Expand brace groups in a workspace glob pattern. Supports the forms
 * that appear in real workspace manifests, like `{apps,packages}/*`
 * and nested forms like `{apps,packages}/{core,web}`. Returns an array
 * of expanded patterns with no braces. No-op for patterns that don't
 * contain `{...}`. Does not support escaped braces or nested braces
 * inside a group (neither appears in real workspace manifests).
 */
function expandBraces(pattern: string): Array<string> {
  const match = pattern.match(/^([^{}]*)\{([^{}]*)\}(.*)$/);
  if (!match) {
    return [pattern];
  }
  const [, before, group, after] = match;
  const options = group
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (options.length === 0) {
    // Empty group like `{}` — pass through unchanged.
    return [pattern];
  }
  const results: Array<string> = [];
  for (const opt of options) {
    for (const sub of expandBraces(before + opt + after)) {
      results.push(sub);
    }
  }
  return results;
}

/**
 * Match a path against a workspace glob pattern. Supports the forms
 * that appear in real workspace manifests:
 *   - Literal path: `packages/void`              → exact match.
 *   - Leading `./`: `./packages/*`               → stripped before matching.
 *   - Single-segment glob: `packages/*`          → one segment under prefix.
 *   - Partial-segment glob: `packages/*-app`     → regex within a segment.
 *   - Recursive glob: `packages/**`              → any depth under prefix.
 *   - Brace expansion: `{apps,packages}/*`       → expanded before matching.
 * Does not support character classes or extended globs — those don't
 * appear in any workspace manifest we've seen, and adding a full
 * minimatch pulls in a dep we don't need.
 */
function matchesWorkspacePattern(relPath: string, pattern: string): boolean {
  // Brace expansion first: `{apps,packages}/*` becomes
  // `['apps/*', 'packages/*']`, then ANY expansion matching the path
  // counts. Real workspace manifests use this form frequently.
  const expansions = expandBraces(pattern);
  return expansions.some((p) => matchesSingleWorkspacePattern(relPath, p));
}

function matchesSingleWorkspacePattern(relPath: string, pattern: string): boolean {
  // Normalize: strip leading `./`, then leading/trailing slashes, then
  // split into segments. `./packages/*` is a common shape in real
  // `pnpm-workspace.yaml` / `package.json#workspaces` files.
  const normalizedPattern = pattern.replace(/^\.\/+/, '');
  const pathSegs = relPath
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);
  const patSegs = normalizedPattern
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);
  const compiled = patSegs.map(compilePatternSegment);
  return matchSegments(pathSegs, 0, compiled, 0);
}

type CompiledSegment =
  | { kind: 'literal'; value: string }
  | { kind: 'regex'; re: RegExp }
  | { kind: 'globstar' };

function compilePatternSegment(seg: string): CompiledSegment {
  if (seg === '**') {
    return { kind: 'globstar' };
  }
  if (!seg.includes('*')) {
    return { kind: 'literal', value: seg };
  }
  // Any segment with `*` characters (but not the whole-segment `**`
  // globstar): convert to an anchored regex where each `*` matches any
  // characters except `/`. Regex metacharacters in the literal parts
  // are escaped first. Supports `packages/*`, `packages/*-app`,
  // `packages/app-*`, and mixed forms like `*/foo-*`.
  const re = new RegExp(
    '^' +
      seg
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*') +
      '$',
  );
  return { kind: 'regex', re };
}

function matchSegments(
  path: Array<string>,
  pi: number,
  pat: Array<CompiledSegment>,
  qi: number,
): boolean {
  while (qi < pat.length) {
    const seg = pat[qi];
    if (seg.kind === 'globstar') {
      // Recursive: consume zero or more path segments until the rest
      // matches, or we run out. An empty pattern tail (`**` is the
      // last segment) matches any remaining path including empty.
      if (qi === pat.length - 1) {
        return true;
      }
      for (let k = pi; k <= path.length; k++) {
        if (matchSegments(path, k, pat, qi + 1)) {
          return true;
        }
      }
      return false;
    }
    if (pi >= path.length) {
      return false;
    }
    if (seg.kind === 'literal') {
      if (seg.value !== path[pi]) {
        return false;
      }
    } else {
      // Regex segment: match the single path segment against the
      // compiled regex. Covers both `*` (which compiles to `[^/]*`)
      // and partial globs like `*-app`.
      if (!seg.re.test(path[pi])) {
        return false;
      }
    }
    pi++;
    qi++;
  }
  // Pattern fully matched: path must also be fully consumed.
  return pi === path.length;
}

/**
 * Verify that `root` is actually a declared member of the workspace
 * rooted at `workspaceRoot`. An ancestor workspace root found by
 * `findWorkspaceRoot` is not enough — a standalone app nested under a
 * monorepo (e.g. `repo/scratch/my-app` inside a repo whose
 * `pnpm-workspace.yaml` only lists `packages/*`) is NOT a workspace
 * subpackage, and treating it as one leaves the demo scaffold in a
 * broken state: install is skipped, `generateStarterMigration` is
 * skipped, and the user ends up with unresolved `void` imports.
 *
 * Supports positive and negation (`!pattern`) patterns. A path is
 * considered a member if it matches at least one positive pattern and
 * no negation pattern.
 *
 * Returns `false` if no patterns are declared at all — callers treat
 * that as "not a subpackage" so the fresh-clone install path still runs.
 */
function isWorkspaceSubpackage(workspaceRoot: string, root: string): boolean {
  const relPath = relative(workspaceRoot, root);
  // `root === workspaceRoot` means we're AT the workspace root, not
  // inside it. `findWorkspaceRoot` already skips `start` itself so this
  // shouldn't normally fire, but be defensive.
  if (relPath === '' || relPath.startsWith('..')) {
    return false;
  }
  const normalized = relPath.split(/[\\/]/).join('/');
  const patterns = readWorkspacePatterns(workspaceRoot);
  if (patterns.length === 0) {
    return false;
  }
  let matched = false;
  for (const raw of patterns) {
    const isNegation = raw.startsWith('!');
    const pattern = isNegation ? raw.slice(1) : raw;
    if (matchesWorkspacePattern(normalized, pattern)) {
      if (isNegation) {
        return false;
      }
      matched = true;
    }
  }
  return matched;
}

/**
 * Returns true iff `root` is structurally a declared member of an
 * ancestor workspace — regardless of whether the subpackage manages its
 * own install via a local lockfile or Corepack pin. This is the signal
 * Step 8 (GitHub Actions) uses: `.github/workflows/*` files are only
 * read from the repository root, so dropping them under a subpackage
 * root is always wrong, whether or not the subpackage self-manages
 * install.
 */
function isInsideWorkspaceSubpackage(root: string): boolean {
  const workspaceRoot = findWorkspaceRoot(root);
  if (workspaceRoot === undefined) {
    return false;
  }
  return isWorkspaceSubpackage(workspaceRoot, root);
}

/**
 * Returns the workspace root if `root` should defer its install +
 * starter migration to a parent workspace install — i.e. it is a
 * declared member of an ancestor workspace AND has no local lockfile or
 * non-pnpm Corepack pin claiming it manages its own install. Returns
 * undefined when `root` is either not a subpackage at all, or is a
 * leaf-managed project nested inside a workspace.
 *
 * This is the single source of truth used by both the starter and the
 * demo branches in `runInitCommand` so they can never disagree about
 * whether to skip install/migration.
 */
function resolveWorkspaceDeferral(
  root: string,
  pkg: JsonObject | undefined,
): { workspaceRoot: string } | undefined {
  const workspaceRoot = findWorkspaceRoot(root);
  if (workspaceRoot === undefined) {
    return undefined;
  }
  if (!isWorkspaceSubpackage(workspaceRoot, root)) {
    return undefined;
  }
  if (hasLocalLockfile(root)) {
    return undefined;
  }
  // A local Corepack pin for a non-pnpm manager is the same kind of
  // self-management signal as a local lockfile — `isPnpmProject` already
  // treats it as a refusal to walk ancestors. Mirror it here so the
  // two helpers can never disagree.
  const localPm = parsePackageManagerField(pkg);
  if (localPm === 'bun' || localPm === 'yarn' || localPm === 'npm') {
    return undefined;
  }
  return { workspaceRoot };
}

export function detectProjectState(root: string): ProjectState {
  let hasTypescript = false;
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    const pkgRecord = (pkg ?? {}) as { dependencies?: unknown; devDependencies?: unknown };
    const allDeps = {
      ...(asRecord(pkgRecord.dependencies) ?? {}),
      ...(asRecord(pkgRecord.devDependencies) ?? {}),
    };
    hasTypescript = 'typescript' in allDeps;
  } catch {
    // no package.json
  }

  let packageManager: ProjectState['packageManager'] | undefined;
  if (existsSync(join(root, 'pnpm-lock.yaml'))) {
    packageManager = 'pnpm';
  } else if (existsSync(join(root, 'yarn.lock'))) {
    packageManager = 'yarn';
  } else if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))) {
    packageManager = 'bun';
  } else if (existsSync(join(root, 'pnpm-workspace.yaml'))) {
    // No lockfile yet, but `pnpm-workspace.yaml` at the project root is a
    // strong local pnpm signal — it is the same marker `isPnpmProject()`
    // treats as authoritative above. Fresh pnpm workspaces (no lockfile,
    // no Corepack pin) still need `pnpm install`, not `npm install`: the
    // rest of the demo / starter code paths already treat the repo as pnpm
    // via `isPnpmProject`, and falling through to `npm install` here would
    // either reject `workspace:` specs outright or leave a stray
    // `package-lock.json` behind in a pnpm workspace.
    packageManager = 'pnpm';
  } else {
    // No lockfile and no pnpm-workspace.yaml — honor
    // `package.json#packageManager` (Corepack field) for pnpm, yarn, and
    // bun before defaulting to npm. Fresh pnpm workspaces with committed
    // `packageManager` pins but no lockfile would get their `workspace:`
    // specs rejected by npm, and fresh Yarn projects would get an
    // `npm install` that creates the wrong lockfile and bypasses Yarn's
    // linker/plugin settings.
    const field = parsePackageManagerField(pkg);
    if (field === 'pnpm' || field === 'yarn' || field === 'bun') {
      packageManager = field;
    } else {
      packageManager = 'npm';
    }
  }

  const paths = readProjectPaths(root);
  return {
    hasTypescript,
    hasTsconfig: existsSync(join(root, 'tsconfig.json')),
    hasGithubWorkflows: existsSync(join(root, '.github', 'workflows')),
    hasRoutes: existsSync(paths.routesDir),
    hasMigrations: existsSync(paths.migrationsDir) || existsSync(join(root, 'migrations')),
    hasPages: existsSync(paths.pagesDir),
    packageManager,
    typescriptWanted: hasTypescript,
  };
}

function findViteConfig(root: string): string | undefined {
  return VITE_CONFIG_FILES.find((file) => existsSync(join(root, file)));
}

function hasDrizzleSchema(root: string): boolean {
  const paths = readProjectPaths(root);
  return existsSync(paths.schemaFile) || existsSync(paths.schemaDir);
}

function detectPagesFramework(root: string): ScaffoldFramework | undefined {
  const pkg = readPackageJson(root);
  if (!pkg) {
    return undefined;
  }
  return detectScaffoldFrameworkFromDependencies({
    ...(asRecord(pkg.dependencies) ?? {}),
    ...(asRecord(pkg.devDependencies) ?? {}),
  });
}

function readPackageJson(root: string): JsonObject | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    return asRecord(pkg) ?? undefined;
  } catch {
    return undefined;
  }
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

function getDeclaredDependencySpec(root: string, packageName: string): string | undefined {
  const pkg = readPackageJson(root);
  if (!pkg) {
    return undefined;
  }

  for (const field of DEPENDENCY_FIELDS) {
    const group = asRecord(pkg[field]);
    if (typeof group?.[packageName] === 'string') {
      return group[packageName] as string;
    }
  }

  return undefined;
}

function resolveScaffoldDependencySpec(
  root: string,
  packageName: string,
  fallbackVersion: string,
): string {
  return getDeclaredDependencySpec(root, packageName) || fallbackVersion;
}

function defaultPackageName(root: string): string {
  return (
    basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-') || 'my-app'
  );
}

function setupTsconfig(
  root: string,
  state: ProjectState,
  pagesFramework?: ScaffoldFramework,
): void {
  const tsconfigPath = join(root, 'tsconfig.json');

  if (state.hasTsconfig) {
    // Case C: existing tsconfig — check and offer fixes
    let tsconfig: JsonObject;
    try {
      const parsed = parseJsoncFile(tsconfigPath);
      if (!parsed) {
        throw new SyntaxError('Failed to parse tsconfig.json');
      }
      tsconfig = parsed;
    } catch {
      log.warn('Could not parse tsconfig.json, skipping');
      return;
    }

    let updated = false;
    const rootPathBaseDir = effectiveConfigPathBaseDir(tsconfig, tsconfigPath);
    const existingPatch = collectTsconfigPatchFromConfig(
      tsconfig,
      tsconfigPath,
      root,
      rootPathBaseDir,
      new Set(),
    );
    const voidPatch = createVoidTsconfigPatch(root, rootPathBaseDir);

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
    const compilerOptions = asRecord(tsconfig.compilerOptions) ?? {};
    tsconfig.compilerOptions = compilerOptions;
    const types = Array.isArray(compilerOptions.types)
      ? compilerOptions.types.filter((value): value is string => typeof value === 'string')
      : [];
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

    compilerOptions.types = types;

    const existingFiles = uniqueStrings(existingPatch.files);
    if (existingFiles.length > 0 || Array.isArray(tsconfig.files)) {
      const files = uniqueStrings([...existingFiles, ...voidPatch.files]);
      if (JSON.stringify(tsconfig.files) !== JSON.stringify(files)) {
        tsconfig.files = files;
        updated = true;
        log.success('Updated tsconfig.json — merged generated Void type files');
      }
    }

    if (Object.keys(existingPatch.paths).length > 0 || asRecord(compilerOptions.paths) !== null) {
      const paths = { ...existingPatch.paths };
      mergePathMaps(paths, voidPatch.paths);
      const existingPaths = readPaths(compilerOptions.paths);
      if (JSON.stringify(existingPaths) !== JSON.stringify(paths)) {
        compilerOptions.paths = paths;
        updated = true;
        log.success('Updated tsconfig.json — merged generated Void path aliases');
      }
    }

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

function readProjectWranglerCompatDate(root: string): string | undefined {
  const configPath = materializeCloudflareConfig(root);
  if (!existsSync(configPath)) {
    return undefined;
  }
  try {
    const errors: Array<ParseError> = [];
    const parsed = parse(readFileSync(configPath, 'utf-8'), errors);
    if (errors.length === 0 && typeof parsed?.compatibility_date === 'string') {
      return parsed.compatibility_date;
    }
  } catch {
    // Ignore unreadable or invalid wrangler config and fall back to today's date.
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

  const hadConfig = existsSync(materializeCloudflareConfig(root));
  const result = writeProvisionedWranglerConfig(root, {
    compatibilityDate: LATEST_KNOWN_COMPAT_DATE,
    compatibilityFlags: ['nodejs_als'],
  });

  if (result.modified) {
    log.success(
      hadConfig
        ? 'Updated Cloudflare config with compatibility_date and nodejs_als'
        : 'Created Cloudflare config with compatibility_date and nodejs_als',
    );
  } else {
    log.success(`${basename(result.configPath)} looks good`);
  }
}

export function ensureVoidWorkerCompatibilityDate(root: string): void {
  const config = readConfig(root) as Record<string, unknown>;

  if (typeof config.target === 'string' && config.target !== 'cloudflare') {
    return;
  }

  const worker = asRecord(config.worker) ?? {};
  if (typeof worker.compatibility_date === 'string' && worker.compatibility_date.length > 0) {
    return;
  }

  const compatibilityDate = readProjectWranglerCompatDate(root) ?? LATEST_KNOWN_COMPAT_DATE;
  if (!canRewriteVoidProjectConfig(root)) {
    writeProvisionedWranglerConfig(root, { compatibilityDate });
    log.success('Pinned worker compatibility_date in void.lock.json');
    return;
  }
  config.worker = {
    ...worker,
    compatibility_date: compatibilityDate,
  };
  writeVoidProjectConfig(root, config);
  log.success('Pinned worker compatibility_date in void.config.ts');
}

function clearConfiguredDatabase(
  root: string,
  messages: { unchanged: string; updated: string },
): void {
  const config = readConfig(root) as Record<string, unknown>;

  if (config.database !== 'pg' && config.database !== 'mysql') {
    log.info(messages.unchanged);
    return;
  }

  delete config.database;

  writeVoidProjectConfig(root, config);
  log.success(messages.updated);
}

function applyDatabaseDialect(root: string, dialect: DatabaseDialect): void {
  const config = readConfig(root) as Record<string, unknown>;

  if (dialect === 'postgresql') {
    if (config.database === 'pg') {
      log.info('PostgreSQL already configured in void.config.ts');
      return;
    }

    config.database = 'pg';
    writeVoidProjectConfig(root, config);
    log.success('Configured PostgreSQL in void.config.ts');
    return;
  }

  if (dialect === 'mysql') {
    if (config.database === 'mysql') {
      log.info('MySQL already configured in void.config.ts');
      return;
    }

    config.database = 'mysql';
    writeVoidProjectConfig(root, config);
    log.success('Configured MySQL in void.config.ts');
    return;
  }

  clearConfiguredDatabase(root, {
    unchanged: 'Using default D1 (SQLite) configuration',
    updated: 'Updated void.config.ts to use the default D1 (SQLite) configuration',
  });
}

function detectDatabaseSetup(root: string): DatabaseSetupChoice {
  const dialect = getDatabaseDialect(readConfig(root));
  if (dialect !== 'sqlite') {
    return dialect;
  }
  if (
    hasDrizzleSchema(root) ||
    existsSync(readProjectPaths(root).migrationsDir) ||
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
      updated: 'Removed database config from void.config.ts',
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
        hint: 'Scaffolds the same starter with PostgreSQL, a generated migration, a seed file, and writes database: "pg" to void.config.ts.',
      },
      {
        value: 'mysql',
        label: 'MySQL',
        hint: 'Scaffolds the same starter with MySQL, a generated migration, a seed file, and writes database: "mysql" to void.config.ts.',
      },
      {
        value: 'static',
        label: 'Static Pages',
        hint: 'No database or server starter files yet. Good for content sites; add Void features later.',
      },
    ],
  });

  if (isCancel(choice) || typeof choice === 'symbol') {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  return choice as ScaffoldStarterMode;
}

async function promptScaffoldToolchain(): Promise<ScaffoldToolchain> {
  const choice = await select({
    message: 'Choose a Pages scaffold toolchain:',
    initialValue: 'vite-plus',
    options: [...SCAFFOLD_TOOLCHAIN_OPTIONS],
  });

  if (isCancel(choice)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  return choice as ScaffoldToolchain;
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
        value: 'mysql',
        label: currentSetup === 'mysql' ? 'MySQL [current]' : 'MySQL',
        hint: 'Bring your own MySQL via Hyperdrive; ideal for existing MySQL infrastructure and compatible providers.',
      },
      {
        value: 'none',
        label: 'No Database Yet',
        hint: 'Skip database setup for now. You can add D1, PostgreSQL, or MySQL later as your app grows.',
      },
    ],
  });

  if (isCancel(choice)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  return choice as DatabaseSetupChoice;
}

async function promptDeploymentPlatform(root: string): Promise<DeploymentPlatform> {
  const current = readDeploymentPlatform(root);
  const choice = await select({
    message: 'Where should this project deploy?',
    initialValue: current ?? 'cloudflare',
    options: [
      {
        value: 'cloudflare',
        label: current === 'cloudflare' ? 'Cloudflare [current]' : 'Cloudflare',
        hint: 'Deploy to your own Cloudflare account. (default)',
      },
      {
        value: 'void',
        label: current === 'void' ? 'Void [current]' : 'Void',
        hint: "Deploy to your company's Void Platform.",
      },
      {
        value: 'none',
        label: current === 'none' ? 'Skip deployment setup [current]' : 'Skip deployment setup',
        hint: 'Use Void locally or deploy another way.',
      },
    ],
  });

  if (isCancel(choice) || typeof choice === 'symbol') {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  const platform = choice as DeploymentPlatform;
  writeDeploymentPlatform(root, platform);
  return platform;
}

export async function ensureVoidPlatformConnection(
  root: string,
): Promise<PlatformDiscoveryDocument> {
  let selectedApiUrl: string | null = null;
  let promptedForPlatform = false;
  try {
    const { getApiUrl, getSiteDomain } = await import('./auth.ts');
    selectedApiUrl = getApiUrl(root);
    getSiteDomain(root);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('No Void platform connected')) {
      throw error;
    }
    // A genuinely new user must identify the company platform before login.
  }
  if (!selectedApiUrl) {
    promptedForPlatform = true;
    const value = await text({
      message: 'Void platform API URL:',
      placeholder: 'https://platform.example.com',
    });
    if (isCancel(value) || typeof value === 'symbol') {
      cancel('Setup cancelled.');
      process.exit(0);
    }
    selectedApiUrl = String(value);
  }
  const discovery = await discoverPlatform(selectedApiUrl);
  saveDiscoveredPlatform(discovery);
  if (promptedForPlatform) {
    log.success(`Connected to ${discovery.displayName} at ${discovery.apiUrl}.`);
  }
  return discovery;
}

async function setupCloudflareDeployment(root: string): Promise<void> {
  try {
    await connectCloudflare(root, true);
  } catch (error) {
    log.warn(error instanceof Error ? error.message : String(error));
    note(
      'Run `void connect --platform cloudflare` when you want to finish Cloudflare setup.',
      'Cloudflare deployment',
    );
  }
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

// Per-package-manager install + setup steps. `void deploy` always runs through
// the package-manager-appropriate runner in the deploy step below.
function getWorkflowSetupSteps(
  root: string,
  pm: ProjectState['packageManager'],
): { setup: string; install: string; runner: string } {
  const nodeVersion = getNodeVersionLine(root);
  switch (pm) {
    case 'pnpm':
      return {
        setup: `      - uses: pnpm/action-setup@v5
      - uses: actions/setup-node@v6
        with:
          ${nodeVersion}
          cache: pnpm`,
        install: '      - run: pnpm install --frozen-lockfile',
        runner: 'pnpm exec void',
      };
    case 'yarn':
      return {
        setup: `      - uses: actions/setup-node@v6
        with:
          ${nodeVersion}
          cache: yarn`,
        install: '      - run: yarn install --immutable',
        runner: 'yarn void',
      };
    case 'bun':
      return {
        setup: '      - uses: oven-sh/setup-bun@v2',
        install: '      - run: bun install --frozen-lockfile',
        runner: 'bunx void',
      };
    default:
      return {
        setup: `      - uses: actions/setup-node@v6
        with:
          ${nodeVersion}
          cache: npm`,
        install: '      - run: npm ci',
        runner: 'npx void',
      };
  }
}

/**
 * Scaffold the GitHub Actions workflow that deploys via GitHub OIDC — no
 * long-lived secret stored in the repo. `void deploy` itself detects GitHub
 * Actions, mints an OIDC token (audience `void`), exchanges it at
 * `POST $VOID_API_URL/auth/github-oidc` for a short-lived, project-scoped deploy
 * token, and uses it — so the workflow is a single `void deploy` step (no
 * curl/jq). `permissions: id-token: write` is still required: it is what lets
 * the job (and thus the CLI) mint the OIDC token.
 *
 * `slug` is the linked project slug when known (from `.void/project.json`);
 * otherwise a `${{ vars.VOID_PROJECT }}` placeholder is emitted with a comment
 * telling the user to set the repository variable.
 */
export function getWorkflowYaml(
  root: string,
  pm: ProjectState['packageManager'],
  slug: string | null,
  platform: 'cloudflare' | 'void' = 'void',
  platformApiUrl?: string,
): string {
  const { setup, install, runner } = getWorkflowSetupSteps(root, pm);
  if (platform === 'cloudflare') {
    return `name: Deploy to Cloudflare
on:
  push:
    branches: [main]

concurrency:
  group: void-cloudflare-deploy-\${{ github.repository }}-\${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
${setup}
${install}
      - name: Deploy
        env:
          # Add this scoped token at Settings → Secrets and variables → Actions.
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          # Required only for PostgreSQL/MySQL provisioning and migrations.
          DATABASE_URL: \${{ secrets.DATABASE_URL }}
          # Required in fresh checkouts when a Worker Version has no preview URL.
          CLOUDFLARE_WORKERS_SUBDOMAIN: \${{ vars.CLOUDFLARE_WORKERS_SUBDOMAIN }}
          # Required only when Cloudflare Access protects Worker readiness.
          CF_ACCESS_CLIENT_ID: \${{ secrets.CF_ACCESS_CLIENT_ID }}
          CF_ACCESS_CLIENT_SECRET: \${{ secrets.CF_ACCESS_CLIENT_SECRET }}
        run: ${runner} deploy --platform cloudflare
`;
  }
  if (!platformApiUrl) {
    throw new Error(
      'init: Connect to a Void platform before generating a deployment workflow. Run `void connect <url>` first.',
    );
  }
  // When the slug is unknown, fall back to a repository variable and prefix the
  // `VOID_PROJECT` line with a comment (each comment line indented to 2 spaces
  // so it stays inside the `env:` mapping and the YAML remains valid).
  const projectLine = slug
    ? `VOID_PROJECT: ${slug}`
    : `# Set a VOID_PROJECT repository variable to your project slug
  # (Settings → Secrets and variables → Actions → Variables).
  VOID_PROJECT: \${{ vars.VOID_PROJECT }}`;
  return `name: Deploy to Void
on:
  push:
    branches: [main]

# Latest push wins: cancel an in-flight deploy for the same repo+branch so a
# newer commit is never overtaken by an older one. Keyed by repo + ref only —
# workflow-level concurrency cannot read the \`env\` context, so VOID_PROJECT is
# not used here (one repo+branch deploys to one project in this scaffold).
concurrency:
  group: void-deploy-\${{ github.repository }}-\${{ github.ref }}
  cancel-in-progress: true

# id-token: write lets the job mint a GitHub OIDC token. No long-lived
# VOID_TOKEN secret is stored — \`void deploy\` mints that OIDC token and
# exchanges it for a short-lived, project-scoped deploy token at deploy time.
permissions:
  id-token: write
  contents: read

env:
  # Override only when intentionally targeting another platform deployment.
  VOID_API_URL: \${{ vars.VOID_API_URL || '${platformApiUrl}' }}
  ${projectLine}

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
${setup}
${install}
      - name: Deploy
        run: |
          ${runner} connect "$VOID_API_URL" --no-login
          ${runner} deploy --platform void --project "$VOID_PROJECT"
`;
}

function setupGithubActions(
  root: string,
  state: ProjectState,
  platform: 'cloudflare' | 'void' = 'void',
  platformApiUrl?: string,
): void {
  const workflowDir = join(root, '.github', 'workflows');
  const workflowPath = join(workflowDir, 'void-deploy.yml');

  if (existsSync(workflowPath)) {
    log.warn('void-deploy.yml already exists, skipping');
    return;
  }

  const slug = readProjectConfig(root)?.slug ?? null;

  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(
    workflowPath,
    getWorkflowYaml(root, state.packageManager, slug, platform, platformApiUrl),
  );
  log.success('Created .github/workflows/void-deploy.yml');

  if (platform === 'cloudflare') {
    note(
      'Pushes to main will deploy through the same readiness-gated Cloudflare path.\n' +
        'Add a scoped CLOUDFLARE_API_TOKEN repository secret; PostgreSQL/MySQL apps also need DATABASE_URL.\n' +
        'Keep cloudflare.account_id in void.config.ts.',
      'GitHub Actions Cloudflare deploy',
    );
  } else if (slug) {
    note(
      `Pushes to main will build and deploy "${slug}" via GitHub OIDC — no token to store.\n` +
        'Connect the repo to your project in the Void dashboard to authorize it.',
      'GitHub Actions OIDC deploy',
    );
  } else {
    note(
      'Pushes to main will build and deploy via GitHub OIDC — no token to store.\n' +
        'Set a VOID_PROJECT repository variable (Settings → Secrets and variables → Actions → Variables)\n' +
        'to your project slug, and connect the repo to your project in the Void dashboard.',
      'GitHub Actions OIDC deploy',
    );
  }
}

/**
 * Bake a resolved project slug into an already-written `void-deploy.yml`.
 *
 * Step 8 (GitHub Actions) runs BEFORE Step 9 (project link), so when a user
 * links a project during the same interactive init the workflow was written
 * with the `${{ vars.VOID_PROJECT }}` placeholder. Once the link resolves a
 * slug, rewrite the placeholder `env.VOID_PROJECT` block in place so the user
 * does not also have to set a repository variable. No-op (returns `false`)
 * when the workflow is missing or the placeholder is not present (e.g. the
 * slug was already known at scaffold time, or the user declined linking).
 */
function patchWorkflowProjectSlug(root: string, slug: string): boolean {
  const workflowPath = join(root, '.github', 'workflows', 'void-deploy.yml');
  if (!existsSync(workflowPath)) {
    return false;
  }
  const yaml = readFileSync(workflowPath, 'utf-8');
  // The placeholder block emitted by `getWorkflowYaml` is three lines: two
  // 2-space-indented comment lines followed by the placeholder value line.
  const placeholderBlock =
    '  # Set a VOID_PROJECT repository variable to your project slug\n' +
    '  # (Settings → Secrets and variables → Actions → Variables).\n' +
    '  VOID_PROJECT: ${{ vars.VOID_PROJECT }}';
  if (!yaml.includes(placeholderBlock)) {
    return false;
  }
  writeFileSync(workflowPath, yaml.replace(placeholderBlock, `  VOID_PROJECT: ${slug}`));
  log.success(`Set VOID_PROJECT: ${slug} in .github/workflows/void-deploy.yml`);
  return true;
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

function removeTopLevelYamlBlock(yaml: string, key: string): string {
  const lines = yaml.split(/\r?\n/);
  const next: Array<string> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!new RegExp(`^${key}:\\s*(?:#.*)?$`).test(line)) {
      next.push(line);
      continue;
    }

    i += 1;
    while (i < lines.length && (lines[i].trim() === '' || /^\s/.test(lines[i]))) {
      i += 1;
    }
    i -= 1;
  }
  return next.join('\n');
}

function pnpmAllowBuildsYaml(): string {
  // better-sqlite3 13 already ships its Node-API binaries; no native build is needed.
  const lines = ['allowBuilds:', '  better-sqlite3: false'];
  for (const dependency of PNPM_ALLOWED_BUILDS) {
    lines.push(`  ${dependency}: true`);
  }
  return lines.join('\n');
}

function insertPnpmAllowBuilds(yaml: string): string {
  const trimmed = yaml.trim();
  const allowBuilds = pnpmAllowBuildsYaml();
  if (trimmed === '') {
    return `${allowBuilds}\n`;
  }

  const lines = trimmed.split(/\r?\n/);
  const packagesIndex = lines.findIndex((line) => /^packages:\s*(?:#.*)?$/.test(line));
  if (packagesIndex === -1) {
    return `${trimmed}\n\n${allowBuilds}\n`;
  }

  let insertIndex = packagesIndex + 1;
  while (
    insertIndex < lines.length &&
    (lines[insertIndex].trim() === '' || /^\s/.test(lines[insertIndex]))
  ) {
    insertIndex += 1;
  }
  lines.splice(insertIndex, 0, '', ...allowBuilds.split('\n'), '');
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

function resolvePnpmConfigRoot(root: string, pkg: JsonObject): string {
  if (
    existsSync(join(root, 'pnpm-workspace.yaml')) ||
    existsSync(join(root, 'pnpm-lock.yaml')) ||
    parsePackageManagerField(pkg) === 'pnpm'
  ) {
    return root;
  }

  // `hasAncestorPnpmMarkers` also verifies `root` is a declared member.
  const workspaceRoot = findWorkspaceRoot(root);
  if (workspaceRoot !== undefined && hasAncestorPnpmMarkers(root)) {
    return workspaceRoot;
  }

  return root;
}

function ensurePnpmAllowBuilds(root: string, pkg: JsonObject): boolean {
  const configRoot = resolvePnpmConfigRoot(root, pkg);
  const workspacePath = join(configRoot, 'pnpm-workspace.yaml');
  const before = existsSync(workspacePath) ? readFileSync(workspacePath, 'utf-8') : '';
  const withoutLegacy = removeTopLevelYamlBlock(
    removeTopLevelYamlBlock(before, 'onlyBuiltDependencies'),
    'allowBuilds',
  );
  const after = insertPnpmAllowBuilds(withoutLegacy);
  if (after !== before) {
    writeFileSync(workspacePath, after);
    log.success(
      configRoot === root
        ? 'Updated pnpm-workspace.yaml with approved builds'
        : `Updated ${relative(root, workspacePath)} with approved builds`,
    );
    return true;
  }
  return false;
}

function installProjectDependencies(
  root: string,
  packageManager: ProjectState['packageManager'],
): void {
  log.step(`Installing dependencies with ${packageManager}`);

  // Init has just changed the manifest. Refresh the lockfile even when pnpm
  // detects a CI host; subsequent CI builds can use frozen installs normally.
  const args = packageManager === 'pnpm' ? ['install', '--no-frozen-lockfile'] : ['install'];
  const result = spawnSync(packageManager, args, {
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
  const dialect = starterMode;
  const configPath = writeDrizzleConfig(
    root,
    dialect === 'postgresql'
      ? 'postgresql://dummy'
      : dialect === 'mysql'
        ? 'mysql://dummy'
        : ':memory:',
    dialect,
  );

  // Snapshot everything drizzle-kit might touch so a
  // mid-write crash can't leave partial artifacts that wedge
  // subsequent `void db` commands on the journal coherence check.
  // Mirrors the rollback pattern in `gen.ts`'s
  // `runMigration`, but extended for the "migrations dir
  // doesn't exist yet" case that only the starter path hits.
  const migrationsDir = readProjectPaths(root).migrationsDir;
  const metaDir = join(migrationsDir, 'meta');
  const journalPath = join(metaDir, '_journal.json');
  const migrationsDirExistedBefore = existsSync(migrationsDir);
  const metaDirExistedBefore = existsSync(metaDir);
  const originalJournalBytes: Buffer | null = existsSync(journalPath)
    ? readFileSync(journalPath)
    : null;
  const snapshotsBefore = metaDirExistedBefore
    ? new Set(readdirSync(metaDir).filter((f) => f.endsWith('_snapshot.json')))
    : new Set<string>();
  const sqlFilesBefore = migrationsDirExistedBefore
    ? new Set(readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')))
    : new Set<string>();

  log.step('Generating initial Drizzle migration');
  // Under Yarn Berry PnP, the spawned `node drizzle-kit` child cannot
  // resolve `void/schema-d1` from the user's `db/schema.ts` without
  // the PnP loaders patched onto `fs` / `Module._resolveFilename`.
  // `buildDrizzleKitSpawnEnv` detects ancestor `.pnp.cjs` /
  // `.pnp.loader.mjs` and injects the right `NODE_OPTIONS` flags so
  // the child behaves the same as if we had run `yarn node
  // drizzle-kit generate`. Non-PnP projects get a plain clone of
  // `process.env`.
  const result = spawnSync(process.execPath, [drizzleKitBin, 'generate', '--config', configPath], {
    cwd: root,
    stdio: 'pipe',
    encoding: 'utf-8',
    shell: process.platform === 'win32',
    env: buildDrizzleKitSpawnEnv(root),
  });

  const failed = Boolean(result.error) || result.status !== 0;
  if (failed) {
    // Best-effort byte-restore of the journal + unlink of any fresh
    // files drizzle-kit may have planted before it crashed. Swallow
    // cleanup errors — the original spawn failure is the actionable
    // signal; a cleanup bug should not shadow it.
    if (originalJournalBytes !== null) {
      try {
        writeFileSync(journalPath, originalJournalBytes);
      } catch {
        // Swallow: surfacing the original failure is more useful.
      }
    } else if (!metaDirExistedBefore && existsSync(metaDir)) {
      // meta/ didn't exist before — nuke anything drizzle-kit planted
      // inside it and remove the dir itself.
      try {
        for (const f of readdirSync(metaDir)) {
          try {
            unlinkSync(join(metaDir, f));
          } catch {
            // Swallow.
          }
        }
        try {
          rmdirSync(metaDir);
        } catch {
          // Swallow.
        }
      } catch {
        // Swallow: a failed readdir is not a useful signal here.
      }
    }
    if (metaDirExistedBefore && existsSync(metaDir)) {
      for (const f of readdirSync(metaDir)) {
        if (f.endsWith('_snapshot.json') && !snapshotsBefore.has(f)) {
          try {
            unlinkSync(join(metaDir, f));
          } catch {
            // Swallow.
          }
        }
      }
    }
    if (!migrationsDirExistedBefore && existsSync(migrationsDir)) {
      // migrations/ didn't exist before — nuke any fresh sql files.
      // Intentionally do NOT rmdir the directory itself: a subsequent
      // retry wants it to exist, and leaving an empty dir behind is
      // harmless.
      try {
        for (const f of readdirSync(migrationsDir)) {
          if (f.endsWith('.sql')) {
            try {
              unlinkSync(join(migrationsDir, f));
            } catch {
              // Swallow.
            }
          }
        }
      } catch {
        // Swallow.
      }
    } else if (migrationsDirExistedBefore && existsSync(migrationsDir)) {
      for (const f of readdirSync(migrationsDir)) {
        if (f.endsWith('.sql') && !sqlFilesBefore.has(f)) {
          try {
            unlinkSync(join(migrationsDir, f));
          } catch {
            // Swallow.
          }
        }
      }
    }
  }

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
  toolchain: ScaffoldToolchain,
): boolean {
  const packageJsonPath = join(root, 'package.json');
  const template = createPagesStarterTemplate({
    framework,
    starterMode,
    toolchain,
    voidPackageSpec: resolveScaffoldDependencySpec(root, 'void', getOwnVersion()),
    adapterPackageSpec: resolveScaffoldDependencySpec(
      root,
      SCAFFOLD_FRAMEWORKS[framework].adapterPackage,
      getOwnVersion(),
    ),
  });
  let pkg: JsonObject = {};

  if (existsSync(packageJsonPath)) {
    try {
      pkg = asRecord(JSON.parse(readFileSync(packageJsonPath, 'utf-8'))) ?? {};
    } catch {
      throw new Error('Could not parse package.json in empty project');
    }
  }

  const fallbackName = defaultPackageName(root);
  if (!pkg.name || typeof pkg.name !== 'string') {
    pkg.name = fallbackName;
  }
  if (pkg.private === undefined) {
    pkg.private = true;
  }
  if (!pkg.type) {
    pkg.type = 'module';
  }

  const scripts = asRecord(pkg.scripts) ?? {};
  pkg.scripts = scripts;
  for (const [name, command] of Object.entries(template.scripts)) {
    const existing = scripts[name];
    if (typeof existing !== 'string' || isStarterScriptCommand(existing)) {
      scripts[name] = command;
    }
  }

  const dependencies = asRecord(pkg.dependencies) ?? {};
  const devDependencies = asRecord(pkg.devDependencies) ?? {};
  pkg.dependencies = dependencies;
  pkg.devDependencies = devDependencies;

  let dependencyAdded = false;
  const ensureDependency = (
    group: 'dependencies' | 'devDependencies',
    name: string,
    fallbackVersion: string,
  ) => {
    const otherGroup = group === 'dependencies' ? 'devDependencies' : 'dependencies';
    const targetGroup = group === 'dependencies' ? dependencies : devDependencies;
    const sourceGroup = otherGroup === 'dependencies' ? dependencies : devDependencies;
    const existing = targetGroup[name] ?? sourceGroup[name];
    if (!targetGroup[name]) {
      targetGroup[name] = existing ?? fallbackVersion;
      dependencyAdded = true;
    }
    if (sourceGroup[name]) {
      delete sourceGroup[name];
      dependencyAdded = true;
    }
  };

  for (const [name, version] of Object.entries(template.dependencies)) {
    ensureDependency('dependencies', name, version);
  }
  for (const [name, version] of Object.entries(template.devDependencies)) {
    ensureDependency('devDependencies', name, version);
  }

  // The pnpm build approval setup must run for workspace
  // subpackages too. `detectProjectState` only checks LOCAL markers and
  // returns `'npm'` for a subpackage without its own lockfile / pin,
  // but `isPnpmProject(root, pkg)` walks ancestors and verifies
  // membership. Gate the allowlist on the ancestor-aware check
  // so the workspace gets `allowBuilds` and its
  // better-sqlite3 / esbuild / sharp / workerd postinstalls run on the next
  // workspace-root `pnpm install`.
  if (isPnpmProject(root, pkg)) {
    ensurePnpmAllowBuilds(root, pkg);
  }
  // The Corepack pin is ONLY for the standalone pnpm case. In a
  // workspace subpackage the pin lives on the workspace root's
  // package.json; duplicating it per-package confuses Corepack and can
  // conflict with the root pin on future upgrades.
  if (
    packageManager === 'pnpm' &&
    resolveWorkspaceDeferral(root, pkg) === undefined &&
    (!pkg.packageManager || typeof pkg.packageManager !== 'string')
  ) {
    pkg.packageManager = 'pnpm@12.4.1';
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
      `Add DATABASE_URL to .env before running \`${devCommand}\`.\n` +
        'Void uses that direct connection for local PostgreSQL development.',
      'PostgreSQL local dev',
    );
  } else if (starterMode === 'mysql') {
    const devCommand = getDevCommand(root);
    note(
      `Add DATABASE_URL to .env before running \`${devCommand}\`.\n` +
        'Void uses that direct connection for local MySQL development.',
      'MySQL local dev',
    );
  }

  return dependencyAdded;
}

type ExistingProjectPackageSetupResult = {
  dependencyAdded: boolean;
  packageJsonMutated: boolean;
};

function hasDeclaredDependency(pkg: JsonObject, name: string): boolean {
  return DEPENDENCY_FIELDS.some((field) => {
    const group = asRecord(pkg[field]);
    return typeof group?.[name] === 'string';
  });
}

function ensureExistingProjectPackage(
  root: string,
  options: { plainViteSetup?: boolean } = {},
): ExistingProjectPackageSetupResult {
  const packageJsonPath = join(root, 'package.json');
  const voidSpec = resolveScaffoldDependencySpec(root, 'void', getOwnVersion());
  const plainViteSetup = options.plainViteSetup ?? true;
  let pkg: JsonObject = {};
  let existedBefore = false;

  if (existsSync(packageJsonPath)) {
    existedBefore = true;
    try {
      pkg = asRecord(JSON.parse(readFileSync(packageJsonPath, 'utf-8'))) ?? {};
    } catch {
      throw new Error('Could not parse package.json while configuring Void');
    }
  }

  const fallbackName = defaultPackageName(root);
  let changed = !existedBefore;
  let dependencyAdded = false;

  if (!pkg.name || typeof pkg.name !== 'string') {
    pkg.name = fallbackName;
    changed = true;
  }
  if (!existedBefore && pkg.private === undefined) {
    pkg.private = true;
    changed = true;
  }
  if (!existedBefore && !pkg.type) {
    pkg.type = 'module';
    changed = true;
  }

  if (plainViteSetup) {
    const scripts = asRecord(pkg.scripts) ?? {};
    pkg.scripts = scripts;
    if (typeof scripts.dev !== 'string') {
      scripts.dev = 'vite';
      changed = true;
    }
    if (typeof scripts.build !== 'string') {
      scripts.build = 'vite build';
      changed = true;
    }
  }

  const devDependencies = asRecord(pkg.devDependencies) ?? {};
  pkg.devDependencies = devDependencies;
  if (!hasDeclaredDependency(pkg, 'void')) {
    devDependencies.void = voidSpec;
    changed = true;
    dependencyAdded = true;
  }
  if (plainViteSetup && !hasDeclaredDependency(pkg, 'vite')) {
    devDependencies.vite = SCAFFOLD_BASE_DEV_DEPENDENCIES.vite;
    changed = true;
    dependencyAdded = true;
  }

  const pnpmConfigChanged = isPnpmProject(root, pkg) ? ensurePnpmAllowBuilds(root, pkg) : false;

  if (changed) {
    writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n');
    log.success(
      existedBefore
        ? plainViteSetup
          ? 'Updated package.json with Void dependencies and Vite scripts'
          : 'Updated package.json with Void dependency'
        : plainViteSetup
          ? 'Created package.json with Void dependencies and Vite scripts'
          : 'Created package.json with Void dependency',
    );
  }

  return { dependencyAdded, packageJsonMutated: changed || pnpmConfigChanged };
}

function getBasicVoidViteConfig(): string {
  return `import { defineConfig } from "vite";
import { voidPlugin } from "void";

export default defineConfig({
  plugins: [voidPlugin()],
});
`;
}

function getGeneratedViteConfigPath(root: string): 'vite.config.ts' | 'vite.config.mts' {
  const pkg = readPackageJson(root);
  return pkg?.type === 'module' ? 'vite.config.ts' : 'vite.config.mts';
}

function noteManualViteConfigSetup(configPath?: string): void {
  const target = configPath ?? 'your framework Vite config';
  note(
    `Could not safely update ${target} automatically.\n\n` +
      `Add \`voidPlugin()\` to the top-level Vite plugins array:\n\n` +
      `import { voidPlugin } from "void";\n\n` +
      `export default defineConfig({\n` +
      `  plugins: [voidPlugin()],\n` +
      `});`,
    'Manual Vite config step',
  );
}

function noteManualFrameworkConfigSetup(framework: DetectedFramework): void {
  if (framework.name === 'astro') {
    note(
      `Detected Astro. Void init does not patch astro.config.* automatically.\n\n` +
        `Add \`voidPlugin()\` to the Astro Vite plugins option:\n\n` +
        `import { voidPlugin } from "void";\n\n` +
        `export default defineConfig({\n` +
        `  vite: { plugins: [voidPlugin()] },\n` +
        `});`,
      'Manual Astro config step',
    );
    return;
  }

  if (framework.name === 'nuxt') {
    note(
      `Detected Nuxt. Void init does not patch nuxt.config.* automatically.\n\n` +
        `Add \`voidPlugin()\` to the Nuxt Vite plugins option:\n\n` +
        `import { voidPlugin } from "void";\n\n` +
        `export default defineNuxtConfig({\n` +
        `  vite: { plugins: [voidPlugin()] },\n` +
        `});`,
      'Manual Nuxt config step',
    );
    return;
  }

  noteManualViteConfigSetup();
}

function ensureExistingProjectViteConfig(root: string, framework?: DetectedFramework): void {
  if (framework?.class === 'c') {
    noteManualFrameworkConfigSetup(framework);
    return;
  }

  const configPath = findViteConfig(root);
  if (!configPath) {
    writeFileIfMissing(root, getGeneratedViteConfigPath(root), getBasicVoidViteConfig());
    return;
  }

  const fullPath = join(root, configPath);
  const original = readFileSync(fullPath, 'utf-8');
  const updated = patchViteConfigWithVoidPlugin(configPath, original);
  if (updated === undefined) {
    noteManualViteConfigSetup(configPath);
    return;
  }
  if (updated === original) {
    log.info(`${configPath} already includes voidPlugin()`);
    return;
  }

  writeFileSync(fullPath, updated);
  log.success(`Added voidPlugin() to ${configPath}`);
}

function setupExistingProject(
  root: string,
  framework?: DetectedFramework,
): {
  dependencyAdded: boolean;
  packageJsonMutated: boolean;
} {
  log.info('Existing project detected. Configuring Void...');
  const packageResult = ensureExistingProjectPackage(root, {
    plainViteSetup: framework?.class !== 'c',
  });
  ensureExistingProjectViteConfig(root, framework);
  return packageResult;
}

/**
 * Scaffolds the minimal "SQL → types → handler → fetch" demo into an
 * existing project. The demo files import from `void/db` and
 * `void/schema-d1`, so `void` MUST be present in `package.json` before
 * the caller runs `installProjectDependencies` +
 * `generateStarterMigration`; otherwise `drizzle-kit generate` cannot
 * resolve the schema imports. This function ensures `void` is declared,
 * preserving whatever spec is already there or adding the current CLI
 * version used by greenfield scaffolds.
 * `scaffoldPagesApp` has the same contract via its template; we just
 * replicate the "ensure void dep" slice here for the demo path.
 */
function scaffoldDemo(root: string): { packageJsonMutated: boolean } {
  const devCommand = getDevCommand(root);
  const paths = readProjectPaths(root);

  const packageJsonMutated = ensureVoidDependency(root);

  mkdirSync(paths.dbDir, { recursive: true });
  writeFileSync(
    paths.schemaFile,
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
  mkdirSync(join(paths.routesDir, 'api'), { recursive: true });
  writeFileSync(
    join(paths.routesDir, 'api', 'posts.ts'),
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
  ensureProjectTsconfig(root, undefined, true, true, { paths });

  // Frontend demo
  mkdirSync(paths.ssrDir, { recursive: true });
  writeFileSync(
    join(paths.ssrDir, 'demo.ts'),
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

  return { packageJsonMutated };
}

/**
 * Ensures `void` is declared in `package.json`, creating the file if it
 * does not exist. This is a narrow, scaffoldDemo-specific helper:
 * `scaffoldPagesApp` handles greenfield projects via
 * `createPagesStarterTemplate` (which knows about adapters,
 * devDependencies, scripts, etc.); `scaffoldDemo` only needs enough in
 * `package.json` for `drizzle-kit generate` to resolve `void/schema-d1`
 * via `node_modules/void` after install.
 */
export function ensureVoidDependency(root: string): boolean {
  const packageJsonPath = join(root, 'package.json');
  const voidSpec = resolveScaffoldDependencySpec(root, 'void', getOwnVersion());

  let pkg: JsonObject = {};
  let existedBefore = false;
  if (existsSync(packageJsonPath)) {
    existedBefore = true;
    try {
      pkg = asRecord(JSON.parse(readFileSync(packageJsonPath, 'utf-8'))) ?? {};
    } catch {
      throw new Error('Could not parse package.json while scaffolding demo');
    }
  }

  const fallbackName = defaultPackageName(root);
  let changed = !existedBefore;
  if (!pkg.name || typeof pkg.name !== 'string') {
    pkg.name = fallbackName;
    changed = true;
  }
  // Only stamp `private: true` when we're creating `package.json` from
  // scratch. Flipping an existing project that intentionally omits
  // `private` (e.g. an app or library meant to be published to a registry)
  // to `private: true` silently changes its publish semantics; the demo
  // scaffold only needs `void` in `devDependencies`, not a publishability
  // flip.
  if (!existedBefore && pkg.private === undefined) {
    pkg.private = true;
    changed = true;
  }
  // Only stamp `type: "module"` when we're creating `package.json` from
  // scratch. Flipping an existing CommonJS project (where `type` is absent)
  // to ESM is a breaking change for any sibling `.js` scripts, tests, or
  // tooling that rely on `require`-based resolution; the demo scaffold only
  // needs `void` in `devDependencies`, not a module-system rewrite.
  if (!existedBefore && !pkg.type) {
    pkg.type = 'module';
    changed = true;
  }

  if (
    !pkg.devDependencies ||
    typeof pkg.devDependencies !== 'object' ||
    Array.isArray(pkg.devDependencies)
  ) {
    pkg.devDependencies = {};
  }
  if (
    !pkg.dependencies ||
    typeof pkg.dependencies !== 'object' ||
    Array.isArray(pkg.dependencies)
  ) {
    pkg.dependencies = {};
  }
  const devDependencies = asRecord(pkg.devDependencies) ?? {};
  pkg.devDependencies = devDependencies;

  // Only touch `void` if it's not already declared in any dependency
  // group (deps, devDeps, peerDeps, optionalDeps).
  if (!hasDeclaredDependency(pkg, 'void')) {
    devDependencies.void = voidSpec;
    changed = true;
  }

  // Mirror `scaffoldPagesApp`'s pnpm build approval config. pnpm requires
  // build scripts to be approved through `allowBuilds`; without this, the freshly scaffolded
  // demo breaks on first local DB / dev commands because
  // `better-sqlite3`/`esbuild`/`sharp`/`workerd` never run their postinstall
  // build steps. Honor both pnpm signals via `isPnpmProject` — a committed
  // `pnpm-lock.yaml` OR a `package.json#packageManager: pnpm` Corepack pin,
  // which `detectProjectState` and `runInitCommand` also treat as pnpm.
  const pnpmConfigChanged = isPnpmProject(root, pkg) ? ensurePnpmAllowBuilds(root, pkg) : false;

  if (changed) {
    writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n');
    log.success(
      existedBefore
        ? 'Ensured void is in package.json devDependencies'
        : 'Created package.json with void as a devDependency',
    );
  }

  return changed || pnpmConfigChanged;
}

function getOwnVersion(): string {
  const pkg = JSON.parse(readFileSync(join(getPackageDir(), 'package.json'), 'utf-8'));
  return pkg.version;
}

const MARKER_VERSION_SOURCE =
  String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?` +
  String.raw`(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`;
const MARKER_OPEN_RE = new RegExp(
  String.raw`^<!--injected-by-void-v(${MARKER_VERSION_SOURCE})-->\r?$`,
  'm',
);
const MARKER_CLOSE = '<!--/injected-by-void-->';
const MARKER_BLOCK_RE = new RegExp(
  String.raw`^<!--injected-by-void-v${MARKER_VERSION_SOURCE}-->\r?\n[\s\S]*?^<!--\/injected-by-void-->\r?$`,
  'm',
);

function injectAgentBlock(root: string): void {
  const filePath = 'AGENTS.md';
  const fullPath = join(root, filePath);
  const version = getOwnVersion();
  const template = readFileSync(join(getPackageDir(), 'AGENTS_TEMPLATE.md'), 'utf-8');
  const openMarker = `<!--injected-by-void-v${version}-->`;
  const block = `${openMarker}\n${template}\n${MARKER_CLOSE}`;

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

export async function runInitCommand(root: string, initArgs?: InitArgs): Promise<void> {
  console.log();

  const targeted = Boolean(initArgs && (initArgs.tsconfig || initArgs.github || initArgs.agents));
  if (!targeted) {
    root = await resolveInitRoot(root);
  }
  const hadTypedConfig = existsSync(join(root, TYPED_CONFIG_FILE));
  if (migrateLegacyVoidConfig(root)) {
    log.success(
      'Migrated project configuration to void.config.ts. Commit void.config.ts and void.lock.json.',
    );
  }
  const workspaceSubpackage = isInsideWorkspaceSubpackage(root);
  if (workspaceSubpackage && initArgs?.git !== undefined) {
    throw new Error(
      'init: The --git/--no-git options are not available when adding a package to an existing monorepo.',
    );
  }
  const gitInitialized =
    !workspaceSubpackage && (!targeted || initArgs?.git !== undefined)
      ? await setupGit(root, initArgs?.git)
      : false;
  const framework = detectFramework(root);
  const preScaffoldState = detectProjectState(root);
  const detectedPagesFramework = detectPagesFramework(root);
  let scaffoldedPagesFramework: ScaffoldFramework | undefined;
  let scaffoldedStarterMode: Exclude<ScaffoldStarterMode, 'static'> | undefined;
  let didScaffoldStarter = false;
  let scaffoldAddedDependencies = false;
  let workspaceSubpackageSkip = false;

  if (framework) {
    log.info(`Detected ${framework.name} framework`);
  }

  if (!targeted && !framework && isScaffoldableEmptyProject(root)) {
    log.info('Empty project detected. Scaffolding a Pages starter...');
    const scaffoldToolchain = await promptScaffoldToolchain();
    if (detectedPagesFramework) {
      scaffoldedPagesFramework = detectedPagesFramework;
      log.info(
        `Detected ${SCAFFOLD_FRAMEWORKS[detectedPagesFramework].label} adapter in package.json`,
      );
    } else {
      scaffoldedPagesFramework = await promptScaffoldFramework();
    }
    const starterMode = await promptStarterMode();
    const scaffoldPackageManager =
      scaffoldToolchain === 'vite-plus' ? 'pnpm' : preScaffoldState.packageManager;
    const scaffoldWroteDeps = scaffoldPagesApp(
      root,
      scaffoldPackageManager,
      scaffoldedPagesFramework,
      starterMode,
      scaffoldToolchain,
    );

    // If this empty directory sits inside a declared workspace subpackage
    // we cannot run a leaf `installProjectDependencies` here: the fallback
    // package manager would pollute the workspace with a stray
    // `node_modules` / lockfile that conflicts with the workspace
    // manager's hoisting, or reject the install outright on `workspace:`
    // specs. Defer to the user's next workspace install via
    // `workspaceSubpackageSkip` and surface a note. The skip also covers
    // `generateStarterMigration` (drizzle-kit cannot resolve
    // `void/schema-d1` from a subpackage with no resolved deps yet).
    //
    // The skip decision routes through `resolveWorkspaceDeferral` for
    // consistency with the demo branch below — both branches honor the
    // same local-lockfile / Corepack veto. `(!voidResolvable || scaffoldWroteDeps)`
    // is defense in depth: in practice `scaffoldWroteDeps` is always
    // true when this branch runs because `isScaffoldableEmptyProject`
    // only whitelists `void` + adapter packages while the starter
    // template additionally injects `hono` / framework lib / `vite` /
    // `typescript`, so `scaffoldPagesApp`'s `ensureDependency()` is
    // guaranteed to flip `dependencyAdded` to true. The `!voidResolvable`
    // disjunct keeps the gate correct even if a future template lands
    // a smaller dep set.
    const deferral = resolveWorkspaceDeferral(root, readPackageJson(root));
    const voidResolvable = isVoidResolvableFrom(root);
    if (deferral && (!voidResolvable || scaffoldWroteDeps)) {
      workspaceSubpackageSkip = true;
      const relRoot = relative(deferral.workspaceRoot, root) || '.';
      // Static starter mode does not scaffold a `db/schema.ts` (see
      // `template.ts:156`), so the `void db generate` follow-up is
      // meaningless there — only emit it for the db-backed starter modes.
      const dbFollowUp =
        starterMode === 'static'
          ? ''
          : `\nthen run \`void db generate\` from ./${relRoot} to create the initial migration.`;
      note(
        `Scaffolded the Pages starter in ./${relRoot}.\n\n` +
          `Run your workspace install from ${deferral.workspaceRoot} to pick up the new dependencies.${dbFollowUp}`,
        'Workspace subpackage',
      );
    } else if (scaffoldWroteDeps || !voidResolvable) {
      // Non-subpackage case (or hoisted-void subpackage with no
      // package.json drift): run install when we either added deps OR
      // when `void` is not yet resolvable from disk. The latter covers
      // the pre-declared-deps path that `isScaffoldableEmptyProject`
      // permits.
      scaffoldAddedDependencies = true;
    }
    if (starterMode !== 'static') {
      scaffoldedStarterMode = starterMode;
    }
    didScaffoldStarter = true;
  }

  const state = detectProjectState(root);
  const pagesFramework = scaffoldedPagesFramework ?? detectPagesFramework(root);

  if (!targeted && !didScaffoldStarter) {
    const existingSetup = setupExistingProject(root, framework);
    const voidResolvable = isVoidResolvableFrom(root);
    const needsInstall = existingSetup.dependencyAdded || !voidResolvable;
    if (needsInstall) {
      const deferral = resolveWorkspaceDeferral(root, readPackageJson(root));
      if (deferral) {
        workspaceSubpackageSkip = true;
        const relRoot = relative(deferral.workspaceRoot, root) || '.';
        note(
          `Configured Void in ./${relRoot}.\n\n` +
            `Run your workspace install from ${deferral.workspaceRoot} to sync the lockfile and pick up the updated dependencies.\n` +
            `If this init flow scaffolds database files, then run \`void db generate\` from ./${relRoot}.`,
          'Workspace subpackage',
        );
      } else {
        scaffoldAddedDependencies = true;
      }
    }
  }

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

  if (!targeted) {
    ensureVoidWorkerCompatibilityDate(root);
  }

  // Step 2: Cloudflare config for class B/C meta-frameworks
  if (framework) {
    setupWranglerConfig(root, framework);
  }
  if (!hadTypedConfig) {
    migrateFrameworkAdapterPaths(root);
  }

  // Step 3: Database dialect
  if (!targeted && !didScaffoldStarter) {
    applyDatabaseSetup(root, await promptDatabaseSetup(root));
  }

  // Steps 4–5: Agent instructions and skills
  if (!targeted || initArgs?.agents) {
    // Step 4: Agent instructions
    injectAgentBlock(root);

    // Step 5: Link skills
    const agents = detectAgents(root);
    if (agents.length > 0) {
      const { linkSkillsForSpecificAgents } = await import('./skills.ts');
      linkSkillsForSpecificAgents(root, agents);
    } else {
      log.info('No coding agent detected; read the bundled docs linked in AGENTS.md');
    }
  }

  // Step 6: Demo code (only in full interactive flow, not for meta-frameworks)
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
        const { packageJsonMutated } = scaffoldDemo(root);
        // `generateStarterMigration` spawns drizzle-kit, which resolves
        // `void/schema-d1` through Node's ancestor `node_modules` walk.
        // The demo install is only necessary when that resolution would
        // fail — i.e. `void` is not present anywhere from `root` upward.
        // `scaffoldDemo` (via `ensureVoidDependency`) may write `void`
        // to the local `package.json` even when `void` is already
        // hoisted at an ancestor `node_modules/void`; that manifest
        // update alone does NOT justify an install here. In hoisted
        // monorepos `isVoidResolvableFrom` returns true via the ancestor
        // walk, so we skip the install — which is important because
        // workspace subpackages with `workspace:` specs often reject
        // `npm install` outright. Fresh clones where `node_modules/void`
        // is entirely missing still trigger the install via
        // `!voidResolvable`.
        //
        // `resolveWorkspaceDeferral` is the single source of truth for
        // "is this a workspace subpackage that should defer install to
        // the root?" — it honors local lockfiles and Corepack pins so
        // a leaf-managed nested project does NOT take the skip path.
        const voidResolvable = isVoidResolvableFrom(root);
        const deferral = resolveWorkspaceDeferral(root, readPackageJson(root));
        if (deferral && (!voidResolvable || packageJsonMutated)) {
          // Workspace subpackage: either we need an install
          // (`!voidResolvable`) or `ensureVoidDependency` mutated
          // `package.json` so the workspace lockfile is now stale.
          // Either way we can't run a leaf `npm install` (would reject
          // `workspace:` specs and pollute the workspace), and we can't
          // safely run the starter migration before the user has
          // reconciled their lockfile.
          workspaceSubpackageSkip = true;
          const relRoot = relative(deferral.workspaceRoot, root) || '.';
          const headline = voidResolvable
            ? `\`void\` is already hoisted at an ancestor node_modules, but \`./${relRoot}/package.json\` was updated.\nRun your workspace install from ${deferral.workspaceRoot} to sync the lockfile,`
            : `Run your workspace install from ${deferral.workspaceRoot} to pick up the new \`void\` dep,`;
          note(
            `Scaffolded the starter demo in ./${relRoot}.\n\n` +
              `${headline}\n` +
              `then run \`void db generate\` from ./${relRoot} to create the initial migration.`,
            'Workspace subpackage',
          );
        } else if (!voidResolvable || packageJsonMutated) {
          // Non-subpackage case. We also enter this branch when
          // `packageJsonMutated` is true even if `void` was already
          // resolvable, because `scaffoldDemo()` added a new `void` entry
          // to the child's `package.json` and the lockfile needs to be
          // reconciled. Without this install, CI frozen-install (or
          // `pnpm install --frozen-lockfile`, `npm ci`,
          // `yarn install --immutable`) would fail the integrity check.
          scaffoldAddedDependencies = true;
        }
        scaffoldedStarterMode = 'sqlite';
      }
    }
  }

  // Step 8: Deployment platform. Targeted init commands retain their focused,
  // non-interactive behavior and do not change the saved preference.
  const deploymentPlatform = !targeted
    ? await promptDeploymentPlatform(root)
    : readDeploymentPlatform(root);
  let voidPlatformDiscovery: PlatformDiscoveryDocument | null = null;

  if (!targeted && deploymentPlatform === 'cloudflare') {
    await setupCloudflareDeployment(root);
  }
  if (!targeted && deploymentPlatform === 'void') {
    voidPlatformDiscovery = await ensureVoidPlatformConnection(root);
  }

  // Step 9: GitHub Actions for either configured deployment target.
  // Skip when `root` is a workspace subpackage: `setupGithubActions` would
  // write `.github/workflows/deploy.yml` under the subpackage root, but
  // GitHub only reads `.github/workflows/*` from the repository root, so
  // the workflow would be silently ignored. The user has to set this up
  // from the workspace root themselves.
  //
  // This check is intentionally NOT `resolveWorkspaceDeferral`: a leaf
  // managed subpackage (local lockfile or a non-pnpm Corepack pin) is
  // still a workspace member structurally, and GitHub still ignores its
  // `.github/workflows/` directory. Self-managing the install does not
  // change where GitHub reads workflow files from. Compute the
  // subpackage-membership signal directly so both targeted and
  // interactive modes agree.
  const githubStepSkipForSubpackage = workspaceSubpackage;
  let shouldSetupGithub = targeted ? initArgs?.github === true : deploymentPlatform !== 'none';
  if (
    shouldSetupGithub &&
    !githubStepSkipForSubpackage &&
    deploymentPlatform !== 'cloudflare' &&
    deploymentPlatform !== 'none'
  ) {
    if (!voidPlatformDiscovery) {
      const { getApiUrl } = await import('./auth.ts');
      voidPlatformDiscovery = await discoverPlatform(getApiUrl(root));
    }
    if (!voidPlatformDiscovery.capabilities.githubActions) {
      const message = `${voidPlatformDiscovery.displayName} does not support GitHub Actions deployments.`;
      if (targeted) {
        throw new Error(`init: ${message}`);
      }
      log.info(`${message} Skipping workflow setup.`);
      shouldSetupGithub = false;
    }
  }
  if (shouldSetupGithub && !githubStepSkipForSubpackage) {
    // `setupGithubActions` writes `void-deploy.yml` (skipping with a warning if
    // it already exists). It does not touch any pre-existing `deploy.yml`.
    if (targeted) {
      // --github flag: run directly without prompting
      setupGithubActions(
        root,
        state,
        deploymentPlatform === 'cloudflare' ? 'cloudflare' : 'void',
        voidPlatformDiscovery?.apiUrl,
      );
    } else {
      const setupGha = await confirm({
        message: 'Create .github/workflows/void-deploy.yml to deploy on pushes to main?',
      });
      if (isCancel(setupGha)) {
        cancel('Setup cancelled.');
        process.exit(0);
      }
      if (setupGha) {
        setupGithubActions(
          root,
          state,
          deploymentPlatform === 'cloudflare' ? 'cloudflare' : 'void',
          voidPlatformDiscovery?.apiUrl,
        );
      }
    }
  } else if (githubStepSkipForSubpackage && shouldSetupGithub) {
    log.info(
      'Skipping GitHub Actions setup: workflow files must live at the repo root, not in a workspace subpackage.',
    );
  }

  if (!targeted) {
    const scaffoldResult = maybeScaffoldEnvTs(root);
    if (scaffoldResult.written) {
      const rel = relative(root, scaffoldResult.written) || 'env.ts';
      if (scaffoldResult.entries.length > 0) {
        log.success(`Scaffolded ${rel} from .env — review inferred types before running dev.`);
      } else {
        log.success(`Created empty ${rel} — add your env keys with \`defineEnv({...})\`.`);
      }
    }
  }

  if (scaffoldAddedDependencies) {
    installProjectDependencies(root, state.packageManager);
  }
  if (scaffoldedStarterMode && !workspaceSubpackageSkip) {
    // `generateStarterMigration` injects the Yarn PnP loaders through
    // `buildDrizzleKitSpawnEnv`, so it works under PnP like
    // `gen.ts:runMigration`.
    generateStarterMigration(root, scaffoldedStarterMode);
  }

  if (!targeted && deploymentPlatform === 'void') {
    const linked = await maybeSetupDeployProject(root);
    // Step 8 wrote `void-deploy.yml` before the project was linked, so it baked
    // in the `${{ vars.VOID_PROJECT }}` placeholder. Now that linking resolved a
    // slug, patch it into the workflow so the user does not also have to set a
    // repository variable. Declining to link leaves the placeholder intact.
    if (linked?.slug) {
      patchWorkflowProjectSlug(root, linked.slug);
    }
  }

  if (gitInitialized) {
    log.info(`Git (optional): ${initialCommitCommand(root)}`);
  }

  if (workspaceSubpackageSkip) {
    // The workspace install + `void db generate` ordering was already
    // surfaced via `note(..., 'Workspace subpackage')` upstream; the
    // outro just nudges the user back toward that note instead of
    // suggesting a dev command they cannot run yet. Static starter mode
    // has no migration step, so omit the `void db generate` half there.
    if (scaffoldedStarterMode) {
      outro('Run your workspace install, then `void db generate` to finish setup.');
    } else {
      outro('Run your workspace install to finish setup.');
    }
  } else {
    outro(`Run \`${getDevCommand(root, framework)}\` to start developing`);
  }
}
