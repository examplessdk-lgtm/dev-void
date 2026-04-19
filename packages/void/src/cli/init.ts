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
import { basename, dirname, join, relative } from 'node:path';
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
import { maybeScaffoldEnvTs } from './env-scaffold';
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
import { buildDrizzleKitSpawnEnv, findInstalledYarnPnpRuntime, hasLocalLockfile } from './yarn-pnp';

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
 * Without the ancestor check, `resolveScaffoldDependencySpec` would
 * incorrectly treat such subpackages as non-pnpm and rewrite their
 * `workspace:*` specs to published `npm:@void-sdk/void@<version>` specs,
 * breaking the link to the local workspace package.
 *
 * Round 33: local non-pnpm signals MUST outrank the ancestor walk. A bun
 * or yarn subproject nested under a pnpm workspace ancestor is still
 * bun/yarn — its local `bun.lockb` / `yarn.lock` / `package-lock.json` or
 * a local Corepack pin for bun/yarn/npm proves the ancestor's pnpm shape
 * does not govern this subpackage. `detectProjectState` would pick
 * bun/yarn for such a project and try to install with that manager, but
 * the round-32 ancestor walk incorrectly declared it pnpm and rewrote
 * `workspace:*` specs to `workspace:@void-sdk/void@*` — which bun and
 * yarn then reject.
 */
function isPnpmProject(root: string, pkg: Record<string, any>): boolean {
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
  if (
    existsSync(join(root, 'bun.lockb')) ||
    existsSync(join(root, 'bun.lock')) ||
    existsSync(join(root, 'yarn.lock')) ||
    existsSync(join(root, 'package-lock.json'))
  ) {
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
 * Round 43: an ancestor `pnpm-workspace.yaml` / `pnpm-lock.yaml` /
 * Corepack pnpm pin alone is NOT proof that `start` is governed by
 * that repo's pnpm install. A scratch app nested under a pnpm
 * monorepo is a separate project when its path doesn't match the
 * workspace globs. Previously this returned `true` too eagerly, and
 * `ensureVoidDependency` / `scaffoldPagesApp` then emitted
 * `workspace:@void-sdk/void@*` specs that the subsequent local
 * `pnpm install` (the standalone fallback path) rejected.
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
 * Round 40: a committed-but-unfetched `.pnp.cjs` is NOT proof that
 * `yarn install` has run. Yarn Berry repos commonly commit `.pnp.cjs`
 * but gitignore `.yarn/cache/*.zip` (zero-install is opt-in), so a
 * fresh clone has the runtime file on disk while the archives it
 * points at are missing. The stricter `findInstalledYarnPnpRuntime`
 * also requires `<pnp-root>/.yarn/install-state.gz` — Yarn's canonical
 * post-install marker, gitignored by convention — as proof that yarn
 * install has actually populated the archives. Without that marker,
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
  // Round 44: an installed PnP runtime still isn't proof that `void`
  // is currently on the dependency graph. Branch switches and edits
  // to package.json can leave stale PnP data where void has been
  // removed; `.pnp.cjs` still exists but the current install target
  // has no void entry. Spawn a tiny probe under the PnP loaders to
  // verify resolution succeeds in the same env drizzle-kit will
  // later run under.
  //
  // Round 45: the probe must match the shape of the installed PnP
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
function readWorkspacePatterns(workspaceRoot: string): string[] {
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
 * never contain escaped quotes.
 *
 * This replaces the original `/\s+#.*$/` strip which was greedy and
 * would truncate legitimate quoted values like `- "path #hash/*"`,
 * leaving a broken glob that silently failed
 * `isWorkspaceSubpackage` membership.
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
export function extractPnpmWorkspacePackages(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/);
  const patterns: string[] = [];
  let inPackages = false;
  for (const rawLine of lines) {
    // Strip YAML comments while respecting quoted content. YAML only
    // treats `#` as a comment marker when it is preceded by whitespace
    // (or is the first character on the line) AND is not inside a
    // quoted scalar. A naive `/\s+#.*$/` strip truncates legitimate
    // quoted values like `- "path #hash/*"` and leaves a broken glob
    // that silently fails the `isWorkspaceSubpackage` membership check.
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
function expandBraces(pattern: string): string[] {
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
  const results: string[] = [];
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

function matchSegments(path: string[], pi: number, pat: CompiledSegment[], qi: number): boolean {
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
  pkg: Record<string, any> | undefined,
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
    hasTypescript = 'typescript' in allDeps || '@typescript/native-preview' in allDeps;
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
    // bun before defaulting to npm. Those are the monorepo / workspace
    // cases that break under `npm install` and were the motivating case
    // for this fallback: fresh pnpm workspaces with committed
    // `packageManager` pins but no lockfile would get their `workspace:`
    // specs rejected by npm, and fresh Yarn projects would silently get
    // an `npm install` that creates the wrong lockfile and bypasses
    // Yarn's linker/plugin settings.
    //
    // Yarn Berry PnP is handled by the round-31 post-install check: if
    // Yarn writes `.pnp.cjs` / `.pnp.loader.mjs` after install,
    // `generateStarterMigration()` is skipped cleanly with a note rather
    // than crashing drizzle-kit resolution through plain `node`. Yarn
    // Classic and Yarn Berry node-modules users get the expected install
    // behavior through this branch.
    const field = parsePackageManagerField(pkg);
    if (field === 'pnpm' || field === 'yarn' || field === 'bun') {
      packageManager = field;
    } else {
      packageManager = 'npm';
    }
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

function toPreviewPackageName(publicPackageName: string): string {
  if (publicPackageName === 'void') {
    return '@void-sdk/void';
  }
  if (publicPackageName.startsWith('@void/')) {
    return publicPackageName.replace(/^@void\//, '@void-sdk/');
  }
  return publicPackageName;
}

export function toAliasedPreviewSpec(
  previewPackageName: string,
  spec: string,
  fallbackVersion: string,
  sourcePreviewPackageName: string = previewPackageName,
  isPnpm: boolean = false,
): string {
  if (spec.startsWith('npm:')) {
    return spec.replace(/@void-sdk\/[^@]+/, previewPackageName);
  }
  if (spec.startsWith('workspace:')) {
    // Fully-qualified aliased spec like `workspace:@void-sdk/foo@^1.0.0` —
    // just swap the embedded package name through.
    if (spec.includes('@void-sdk/')) {
      return spec.replace(/@void-sdk\/[^@]+/, previewPackageName);
    }
    const rest = spec.slice('workspace:'.length);
    // Path-form workspace specs like `workspace:../packages/void` or
    // `workspace:./packages/void` resolve to a workspace package at that
    // relative path — the package-at-path determines the name, not an
    // alias. pnpm rejects `workspace:@void-sdk/void@../packages/void`, so
    // wrapping the path form in an alias would break both empty-project
    // scaffolds and `ensureVoidDependency()` in monorepos that use path-
    // based workspace links.
    //
    // BUT a path-form spec is only meaningful for the exact package the
    // path points at. Reusing an `@void-sdk/void` path for derived adapter
    // specs (`@void-sdk/react`, `@void-sdk/vue`, …) would install the core
    // package under the adapter name, and the adapter import in
    // `vite.config.ts` would no longer resolve the expected exports. When
    // the target differs from the source we cannot derive an adapter path
    // without walking `pnpm-workspace.yaml`; fall back to a workspace-wide
    // pin so the adapter resolves to whichever version the workspace
    // currently has.
    if (/^\.\.?\//.test(rest)) {
      if (previewPackageName === sourcePreviewPackageName) {
        return spec;
      }
      // Derived-adapter case on a non-same-package path-form source. The
      // pnpm-only `workspace:<alias>@<range>` form is unsafe for yarn/bun
      // monorepos that use path-based workspace refs — emitting it there
      // produces an invalid dep and the install step fails. Fall back to
      // the portable `npm:<alias>@<fallbackVersion>` form outside pnpm;
      // every package manager (npm, yarn, bun, pnpm) accepts it. `*` is
      // intentionally avoided for the npm form because it would resolve
      // to whatever is latest on the public registry and defeat the
      // point of the preview alias — pin to the caller's fallback version
      // (the installed void version at scaffold time).
      if (isPnpm) {
        return `workspace:${previewPackageName}@*`;
      }
      return `npm:${previewPackageName}@${fallbackVersion}`;
    }
    // Bare workspace spec like `workspace:*`, `workspace:^`, `workspace:~`,
    // or `workspace:1.2.3`. pnpm supports `workspace:<alias>@<range>`, which
    // resolves `void` to the preview `@void-sdk/void` workspace package at
    // the declared range. Other package managers (yarn berry, bun) don't
    // understand that syntax — emitting it on a non-pnpm project produces
    // an invalid dep and the subsequent install fails. Fall back to the
    // portable `npm:<alias>@<range>` form outside pnpm; every package
    // manager (npm, yarn, bun, pnpm) accepts it.
    //
    // `workspace:^` and `workspace:~` are pnpm-specific shorthands meaning
    // "current workspace version, published with caret/tilde". The bare
    // modifier on its own is not a valid semver, so emitting
    // `workspace:@void-sdk/void@^` or `npm:@void-sdk/void@^` produces a
    // spec every package manager rejects. Treat these (and the unpinned
    // `*` / empty forms) as "no meaningful range" and pin to the caller's
    // fallback version, which is the installed void version at
    // scaffold time.
    const hasMeaningfulRange = rest !== '' && rest !== '*' && rest !== '^' && rest !== '~';
    if (isPnpm) {
      const range = hasMeaningfulRange ? rest : '*';
      return `workspace:${previewPackageName}@${range}`;
    }
    // `npm:<alias>@*` resolves to the latest published version, which
    // defeats the point of the preview alias — pin to the caller's
    // `fallbackVersion` (the installed void version) whenever the
    // workspace spec carries no explicit range.
    const range = hasMeaningfulRange ? rest : fallbackVersion;
    return `npm:${previewPackageName}@${range}`;
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

  // `toAliasedPreviewSpec` needs to know whether to emit the pnpm-only
  // `workspace:<alias>@<range>` form or the portable `npm:<alias>@<range>`
  // fallback for bare workspace specs. Read `package.json` once so
  // `isPnpmProject` can honor both the lockfile and Corepack signals.
  let pkg: Record<string, any> = {};
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
  } catch {
    // no package.json yet — `isPnpmProject` only needs the lockfile signal
  }
  const isPnpm = isPnpmProject(root, pkg);

  const previewPackageName = toPreviewPackageName(packageName);
  const previewSpec = getDeclaredDependencySpec(root, previewPackageName);
  if (previewSpec) {
    // Source and target preview package names match: this lookup found the
    // spec under the exact preview name we're about to install. Path-form
    // specs are safe to pass through unchanged in this branch.
    return toAliasedPreviewSpec(
      previewPackageName,
      previewSpec,
      fallbackVersion,
      previewPackageName,
      isPnpm,
    );
  }

  const existingVoidSpec =
    getDeclaredDependencySpec(root, 'void') ?? getDeclaredDependencySpec(root, '@void-sdk/void');
  if (packageName !== 'void' && existingVoidSpec && usesPreviewPackageAliases(root)) {
    // Source is `@void-sdk/void`, target is a derived adapter like
    // `@void-sdk/react`. For range-form specs this rewrite is fine, but a
    // path-form source spec cannot be meaningfully reused — it points at
    // the void package on disk, not the adapter. Passing the source name
    // here lets `toAliasedPreviewSpec` detect the different-package case
    // and fall back to `workspace:<adapter>@*` instead of installing the
    // core package under the adapter name.
    return toAliasedPreviewSpec(
      previewPackageName,
      existingVoidSpec,
      fallbackVersion,
      '@void-sdk/void',
      isPnpm,
    );
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

/** Today's UTC date as YYYY-MM-DD for wrangler compatibility_date. */
export function getTodayCompatDate(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
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

  // Round 43: snapshot everything drizzle-kit might touch so a
  // mid-write crash can't leave partial artifacts that wedge
  // subsequent `void db` commands on the journal coherence check.
  // Mirrors the rollback pattern in `gen.ts`'s
  // `generateCustomMigration`, but extended for the "migrations dir
  // doesn't exist yet" case that only the starter path hits.
  const migrationsDir = join(root, 'db', 'migrations');
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

  // Round 44: `ensurePnpmBuiltDependencies` must run for pnpm workspace
  // subpackages too. `detectProjectState` only checks LOCAL markers and
  // returns `'npm'` for a subpackage without its own lockfile / pin,
  // but `isPnpmProject(root, pkg)` walks ancestors and (after round 43)
  // verifies membership. Gate the allowlist on the ancestor-aware check
  // so the subpackage gets `pnpm.onlyBuiltDependencies` and its
  // better-sqlite3 / esbuild / workerd postinstalls run on the next
  // workspace-root `pnpm install`.
  if (isPnpmProject(root, pkg)) {
    ensurePnpmBuiltDependencies(pkg);
  }
  // The Corepack pin is ONLY for the standalone pnpm case. In a
  // workspace subpackage the pin lives on the workspace root's
  // package.json; duplicating it per-package confuses Corepack and can
  // conflict with the root pin on future upgrades.
  if (
    packageManager === 'pnpm' &&
    (!pkg.packageManager || typeof pkg.packageManager !== 'string')
  ) {
    pkg.packageManager = 'pnpm@10.33.0';
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

/**
 * Scaffolds the minimal "SQL → types → handler → fetch" demo into an
 * existing project. The demo files import from `void/db` and
 * `void/schema-d1`, so `void` MUST be present in `package.json` before
 * the caller runs `installProjectDependencies` +
 * `generateStarterMigration`; otherwise `drizzle-kit generate` cannot
 * resolve the schema imports. This function ensures `void` is declared,
 * preserving whatever spec is already there or adding the preview-alias
 * spec the rest of the init flow uses for greenfield scaffolds.
 * `scaffoldPagesApp` has the same contract via its template; we just
 * replicate the "ensure void dep" slice here for the demo path.
 */
function scaffoldDemo(root: string): { packageJsonMutated: boolean } {
  const devCommand = getDevCommand(root);

  const packageJsonMutated = ensureVoidDependency(root);

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

  let pkg: Record<string, any> = {};
  let existedBefore = false;
  if (existsSync(packageJsonPath)) {
    existedBefore = true;
    try {
      pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    } catch {
      throw new Error('Could not parse package.json while scaffolding demo');
    }
  }

  const fallbackName =
    basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-') || 'my-app';
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

  // Only touch `void` if it's not already declared as the public name in
  // ANY dependency group (deps, devDeps, peerDeps, optionalDeps). We
  // intentionally ignore `@void-sdk/void` here — the aliasing logic
  // above writes a separate `void` entry that resolves to the preview
  // alias, so a user with only `@void-sdk/void` declared still needs
  // the public-name entry added.
  const voidAlreadyDeclared = DEPENDENCY_FIELDS.some((field) => {
    const group = asRecord(pkg[field]);
    return typeof group?.void === 'string';
  });
  if (!voidAlreadyDeclared) {
    pkg.devDependencies.void = voidSpec;
    changed = true;
  }

  // Mirror `scaffoldPagesApp`'s pnpm built-dep allowlist. pnpm 10 ignores
  // build scripts unless the package is listed in
  // `pnpm.onlyBuiltDependencies`; without this, the freshly scaffolded
  // demo breaks on first local DB / dev commands because
  // `better-sqlite3`/`esbuild`/`workerd` never run their postinstall
  // build steps. Honor both pnpm signals via `isPnpmProject` — a committed
  // `pnpm-lock.yaml` OR a `package.json#packageManager: pnpm` Corepack pin.
  // The lockfile-only check used to miss the no-lockfile pin case, which
  // `detectProjectState` and `runInitCommand` already treat as pnpm; the
  // demo would then run `pnpm install` against the project but skip the
  // allowlist, leaving the local DB / dev setup broken on first run.
  if (isPnpmProject(root, pkg)) {
    const before = JSON.stringify(pkg.pnpm?.onlyBuiltDependencies ?? null);
    ensurePnpmBuiltDependencies(pkg);
    const after = JSON.stringify(pkg.pnpm?.onlyBuiltDependencies ?? null);
    if (before !== after) {
      changed = true;
    }
  }

  if (changed) {
    writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n');
    log.success(
      existedBefore
        ? 'Ensured void is in package.json devDependencies'
        : 'Created package.json with void as a devDependency',
    );
  }

  return changed;
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
  let scaffoldAddedDependencies = false;
  let workspaceSubpackageSkip = false;

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
    const scaffoldWroteDeps = scaffoldPagesApp(
      root,
      preScaffoldState.packageManager,
      scaffoldedPagesFramework,
      starterMode,
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
        const { packageJsonMutated } = scaffoldDemo(root);
        // `generateStarterMigration` spawns drizzle-kit, which resolves
        // `void/schema-d1` through Node's ancestor `node_modules` walk.
        // The demo install is only necessary when that resolution would
        // fail — i.e. `void` is not present anywhere from `root` upward.
        // `scaffoldDemo` (via `ensureVoidDependency`) may write the alias
        // to the local `package.json` even when `void` is already
        // hoisted at an ancestor `node_modules/void`; the alias write
        // alone is desirable (so the next real install picks up the
        // dep) but does NOT justify an install here. In hoisted
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
          // Non-subpackage case: run install so the Yarn PnP detection
          // below can inspect the post-install state of the filesystem.
          // We also enter this branch when `packageJsonMutated` is true
          // even if `void` was already resolvable, because
          // `scaffoldDemo()` added a new `void` entry to the child's
          // `package.json` and the lockfile needs to be reconciled.
          // Without this install, CI frozen-install (or
          // `pnpm install --frozen-lockfile`, `npm ci`,
          // `yarn install --immutable`) would fail the integrity check.
          //
          // `.pnp.cjs` is only written by Yarn Berry AFTER a successful
          // `yarn install`, so this check MUST run before the install
          // gate below.
          scaffoldAddedDependencies = true;
        }
        scaffoldedStarterMode = 'sqlite';
      }
    }
  }

  // Step 8: GitHub Actions
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
  const githubStepSkipForSubpackage = isInsideWorkspaceSubpackage(root);
  if ((!targeted || initArgs?.github) && !githubStepSkipForSubpackage) {
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
  } else if (githubStepSkipForSubpackage && (initArgs?.github || !targeted)) {
    log.info(
      'Skipping GitHub Actions setup: workflow files must live at the repo root, not in a workspace subpackage.',
    );
  }

  if (!targeted) {
    const scaffoldResult = maybeScaffoldEnvTs(root);
    if (scaffoldResult.written) {
      const rel = relative(root, scaffoldResult.written) || 'env.ts';
      if (scaffoldResult.entries.length > 0) {
        log.success(
          `Scaffolded ${rel} from your .env files — review inferred types before running dev.`,
        );
      } else {
        log.success(`Created empty ${rel} — add your env keys with \`defineEnv({...})\`.`);
      }
    }
  }

  if (!targeted) {
    await maybeSetupDeployProject(root);
  }

  if (scaffoldAddedDependencies) {
    installProjectDependencies(root, state.packageManager);
  }
  if (scaffoldedStarterMode && !workspaceSubpackageSkip) {
    // Round 39: `generateStarterMigration` injects the Yarn PnP
    // loaders into the spawned child's `NODE_OPTIONS` via
    // `buildDrizzleKitSpawnEnv`, so it works under PnP the same way
    // `gen.ts:runMigration` does. No skip branch needed.
    generateStarterMigration(root, scaffoldedStarterMode);
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
