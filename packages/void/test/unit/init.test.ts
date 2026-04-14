import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detectProjectState,
  ensureVoidDependency,
  extractPnpmWorkspacePackages,
  generateStarterMigration,
  getTodayCompatDate,
  isScaffoldableEmptyProject,
  isVoidResolvableFrom,
  runInitCommand,
  toAliasedPreviewSpec,
} from '../../src/cli/init';
import { buildDrizzleKitSpawnEnv } from '../../src/cli/yarn-pnp';

const mockSpawnSync = vi.fn();
const mockSelect = vi.fn();
const mockConfirm = vi.fn();
const mockText = vi.fn();
const mockNote = vi.fn();
const mockOutro = vi.fn();
const mockGetToken = vi.fn();
const mockRunLogin = vi.fn();
const mockSaveToken = vi.fn();
const mockIsStagingMode = vi.fn();
const mockListProjects = vi.fn();
const mockCreateProject = vi.fn();

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: (...args: unknown[]) => mockOutro(...args),
  note: (...args: unknown[]) => mockNote(...args),
  log: { success: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), step: vi.fn() },
  confirm: (...args: unknown[]) => mockConfirm(...args),
  select: (...args: unknown[]) => mockSelect(...args),
  text: (...args: unknown[]) => mockText(...args),
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
  isCI: () => false,
  isCancel: (value: unknown) => value === Symbol.for('cancel'),
  cancel: vi.fn(),
}));

vi.mock('../../src/cli/auth', () => ({
  getToken: (...args: unknown[]) => mockGetToken(...args),
  runLogin: (...args: unknown[]) => mockRunLogin(...args),
  saveToken: (...args: unknown[]) => mockSaveToken(...args),
  isStagingMode: (...args: unknown[]) => mockIsStagingMode(...args),
  getSiteDomain: () => 'void.app',
}));

vi.mock('../../src/cli/client', () => ({
  PlatformClient: class {
    listProjects(...args: unknown[]) {
      return mockListProjects(...args);
    }

    createProject(...args: unknown[]) {
      return mockCreateProject(...args);
    }
  },
}));

vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
}));

function withTempDir(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'void-init-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeMockGeneratedMigration(root: string): void {
  const schema = readFileSync(join(root, 'db', 'schema.ts'), 'utf-8');
  const isPostgres = schema.includes('from "void/schema-pg"');
  const migrationsDir = join(root, 'db', 'migrations');
  const metaDir = join(migrationsDir, 'meta');
  mkdirSync(metaDir, { recursive: true });

  writeFileSync(
    join(migrationsDir, '0000_generated.sql'),
    isPostgres
      ? `CREATE TABLE "messages" (
  "id" serial PRIMARY KEY NOT NULL,
  "text" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
`
      : `CREATE TABLE \`messages\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`text\` text NOT NULL,
  \`created_at\` text DEFAULT (datetime('now')) NOT NULL
);
`,
  );
  writeFileSync(
    join(metaDir, '_journal.json'),
    JSON.stringify(
      {
        version: '7',
        dialect: isPostgres ? 'postgresql' : 'sqlite',
        entries: [{ idx: 0, version: '6', when: 0, tag: '0000_generated', breakpoints: true }],
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(
    join(metaDir, '0000_snapshot.json'),
    JSON.stringify({ version: '6', dialect: isPostgres ? 'postgresql' : 'sqlite' }, null, 2) + '\n',
  );
}

function listMigrationSqlFiles(root: string): string[] {
  const migrationsDir = join(root, 'db', 'migrations');
  if (!existsSync(migrationsDir)) {
    return [];
  }
  return readdirSync(migrationsDir)
    .filter((entry) => entry.endsWith('.sql'))
    .sort();
}

afterEach(() => {
  mockSpawnSync.mockReset();
  mockSelect.mockReset();
  mockConfirm.mockReset();
  mockText.mockReset();
  mockNote.mockReset();
  mockOutro.mockReset();
  mockGetToken.mockReset();
  mockRunLogin.mockReset();
  mockSaveToken.mockReset();
  mockIsStagingMode.mockReset();
  mockListProjects.mockReset();
  mockCreateProject.mockReset();
});

beforeEach(() => {
  mockSpawnSync.mockImplementation((command, args, options) => {
    if (
      command === process.execPath &&
      Array.isArray(args) &&
      args[1] === 'generate' &&
      options &&
      typeof options === 'object' &&
      'cwd' in options &&
      typeof options.cwd === 'string'
    ) {
      writeMockGeneratedMigration(options.cwd);
    }
    return { status: 0, stdout: '', stderr: '' };
  });
  mockGetToken.mockReturnValue(null);
  mockRunLogin.mockResolvedValue('token_123');
  mockIsStagingMode.mockReturnValue(false);
  mockListProjects.mockResolvedValue([]);
  mockCreateProject.mockResolvedValue({ id: 'proj_123', slug: 'my-app' });
});

describe('extractPnpmWorkspacePackages', () => {
  it('parses block-style packages list with mixed quoting', () => {
    const yaml = ['packages:', "  - 'packages/*'", '  - "apps/*"', '  - docs', ''].join('\n');
    expect(extractPnpmWorkspacePackages(yaml)).toEqual(['packages/*', 'apps/*', 'docs']);
  });

  it('parses inline flow-style list with a single quoted element', () => {
    // Regression for void-sdk/void#6: real pnpm manifests also accept
    // the flow-style inline form (e.g. generated by some tooling).
    // Without inline support the parser returned [] and
    // `isWorkspaceSubpackage` fell back to the fresh-clone install
    // path inside a subpackage with `workspace:` specs.
    expect(extractPnpmWorkspacePackages("packages: ['packages/*']\n")).toEqual(['packages/*']);
  });

  it('parses inline flow-style list with multiple quoted elements', () => {
    expect(extractPnpmWorkspacePackages("packages: ['packages/*', 'apps/*']\n")).toEqual([
      'packages/*',
      'apps/*',
    ]);
  });

  it('parses inline flow-style list with unquoted elements', () => {
    expect(extractPnpmWorkspacePackages('packages: [packages/*]\n')).toEqual(['packages/*']);
  });

  it('parses inline flow-style list with surrounding whitespace', () => {
    expect(extractPnpmWorkspacePackages("packages: [ 'packages/*' ,  'apps/*' ]\n")).toEqual([
      'packages/*',
      'apps/*',
    ]);
  });

  it('parses inline flow-style list mixing quoted and unquoted elements', () => {
    expect(extractPnpmWorkspacePackages('packages: ["packages/*", apps/*]\n')).toEqual([
      'packages/*',
      'apps/*',
    ]);
  });

  it('returns [] when packages key is absent', () => {
    expect(extractPnpmWorkspacePackages('catalog:\n  vite: ^8.0.0\n')).toEqual([]);
  });

  // Cursor bot review: the old comment-stripping regex `/\s+#.*$/` was
  // greedy and did not respect quoted scalars. A pattern like
  // `- "path #hash/*"` got truncated to `- "path` and silently failed
  // the `isWorkspaceSubpackage` membership check, misrouting a valid
  // subpackage into the fresh-clone install path.
  it('preserves `#` inside a double-quoted workspace pattern', () => {
    const yaml = ['packages:', '  - "path #hash/*"', ''].join('\n');
    expect(extractPnpmWorkspacePackages(yaml)).toEqual(['path #hash/*']);
  });

  it('preserves `#` inside a single-quoted workspace pattern', () => {
    const yaml = ['packages:', "  - 'apps/#one/*'", ''].join('\n');
    expect(extractPnpmWorkspacePackages(yaml)).toEqual(['apps/#one/*']);
  });

  it('strips a trailing comment from a quoted pattern without touching the value', () => {
    const yaml = ['packages:', '  - "apps/*" # top-level apps', '  - docs', ''].join('\n');
    expect(extractPnpmWorkspacePackages(yaml)).toEqual(['apps/*', 'docs']);
  });

  it('preserves `#` inside a quoted flow-style pattern', () => {
    expect(extractPnpmWorkspacePackages('packages: ["a/#b/*", "c/*"]\n')).toEqual([
      'a/#b/*',
      'c/*',
    ]);
  });
});

describe('isVoidResolvableFrom', () => {
  // Round 39: `.pnp.cjs` / `.pnp.loader.mjs` at an ancestor now count
  // as "void is resolvable" — Yarn Berry PnP projects have no
  // `node_modules` tree, so the old ancestor walk returned false and
  // the init flow misrouted into the "fresh workspace subpackage"
  // skip branch. These tests pin the new behavior.
  //
  // Round 40: the PnP branch additionally requires the post-install
  // marker `.yarn/install-state.gz` in the same directory as the
  // runtime file — a committed-but-unfetched `.pnp.cjs` is NOT proof
  // that `yarn install` has actually populated the archives.
  it('returns true when a PnP runtime sits at an ancestor directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-pnp-'));
    try {
      const subApp = join(root, 'packages', 'app');
      mkdirSync(subApp, { recursive: true });
      // `.pnp.cjs` at the workspace root — the common shape. No
      // `node_modules` anywhere. The post-install marker must sit in
      // the same directory as `.pnp.cjs` to count as "installed".
      writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(root, '.yarn'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'install-state.gz'), '');
      expect(isVoidResolvableFrom(subApp)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns true when only `.pnp.loader.mjs` is present (ESM-only shape)', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-pnp-'));
    try {
      writeFileSync(join(root, '.pnp.loader.mjs'), '// pnp loader\n');
      mkdirSync(join(root, '.yarn'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'install-state.gz'), '');
      expect(isVoidResolvableFrom(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Round 40: committed-but-unfetched PnP fresh clone — `.pnp.cjs`
  // lives in version control but `yarn install` hasn't run yet, so
  // `.yarn/install-state.gz` is absent. Trusting `.pnp.cjs` existence
  // alone misrouts `runInitCommand` into the "void is already
  // installed" branch and the subsequent `drizzle-kit generate` spawn
  // crashes because PnP points at missing ZIP archives. Refuse.
  it('returns false when .pnp.cjs exists but .yarn/install-state.gz is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-pnp-fresh-'));
    try {
      writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
      // No `.yarn/install-state.gz` anywhere — fresh clone state.
      expect(isVoidResolvableFrom(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Round 42: Yarn Berry zero-install repos commit `.yarn/cache/*.zip`
  // to version control and commonly gitignore `.yarn/install-state.gz`
  // (or never write it). A populated cache next to `.pnp.cjs` is
  // sufficient proof that the checkout can resolve dependencies — the
  // whole point of zero-install. Refusing this shape misrouts valid
  // workspace subpackages into the "fresh clone" path and skips the
  // starter migration generation.
  it('returns true when .pnp.cjs exists with a populated .yarn/cache (zero-install)', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-pnp-zero-'));
    try {
      writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
      // No `install-state.gz`, but the cache has at least one zip —
      // the classic zero-install shape.
      mkdirSync(join(root, '.yarn', 'cache'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'cache', 'pkg-npm-1.0.0-abcd.zip'), '');
      expect(isVoidResolvableFrom(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Round 42: inverse of the zero-install case — when `.pnp.cjs` is
  // present but `.yarn/cache/` is empty AND `install-state.gz` is
  // absent, neither marker proves the checkout has been populated.
  // Refuse so the caller triggers the install step.
  it('returns false when .pnp.cjs exists but .yarn/cache is empty and install-state.gz is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-pnp-empty-cache-'));
    try {
      writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
      // Empty cache directory (no `.zip` entries), no install-state.gz.
      mkdirSync(join(root, '.yarn', 'cache'), { recursive: true });
      expect(isVoidResolvableFrom(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns true when .pnp.cjs AND .yarn/install-state.gz both exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-pnp-installed-'));
    try {
      writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(root, '.yarn'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'install-state.gz'), '');
      expect(isVoidResolvableFrom(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finds installed PnP at an ancestor directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-pnp-ancestor-'));
    try {
      const subApp = join(root, 'packages', 'app');
      mkdirSync(subApp, { recursive: true });
      writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(root, '.yarn'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'install-state.gz'), '');
      expect(isVoidResolvableFrom(subApp)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Round 40: the same-directory invariant — when we find `.pnp.cjs`
  // at `<root>/app`, we stop walking and check for `install-state.gz`
  // next to it. An `install-state.gz` at an UNRELATED ancestor (for
  // example the parent workspace) must not retroactively validate the
  // subdirectory's `.pnp.cjs`.
  it('returns false when .yarn/install-state.gz is at a DIFFERENT ancestor than .pnp.cjs', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-pnp-mismatch-'));
    try {
      const subApp = join(root, 'app');
      mkdirSync(subApp, { recursive: true });
      // `.pnp.cjs` at the subdirectory — this is where the walk stops.
      writeFileSync(join(subApp, '.pnp.cjs'), '// pnp stub\n');
      // `install-state.gz` only at the ROOT, NOT at `<root>/app`. The
      // stricter helper should refuse because the two markers live in
      // different directories.
      mkdirSync(join(root, '.yarn'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'install-state.gz'), '');
      expect(isVoidResolvableFrom(subApp)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns false for a bare directory with no node_modules and no PnP runtime', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-bare-'));
    try {
      // No node_modules/void, no .pnp.cjs, no .pnp.loader.mjs
      // anywhere up to the filesystem root.
      expect(isVoidResolvableFrom(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns true when `node_modules/void/package.json` exists at `start` (unchanged legacy shape)', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-nm-'));
    try {
      mkdirSync(join(root, 'node_modules', 'void'), { recursive: true });
      writeFileSync(
        join(root, 'node_modules', 'void', 'package.json'),
        JSON.stringify({ name: 'void', version: '0.0.1' }, null, 2) + '\n',
      );
      expect(isVoidResolvableFrom(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns true when `node_modules/void/package.json` exists at an ancestor (hoisted monorepo shape)', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-hoist-'));
    try {
      mkdirSync(join(root, 'node_modules', 'void'), { recursive: true });
      writeFileSync(
        join(root, 'node_modules', 'void', 'package.json'),
        JSON.stringify({ name: 'void', version: '0.0.1' }, null, 2) + '\n',
      );
      const subApp = join(root, 'packages', 'app');
      mkdirSync(subApp, { recursive: true });
      expect(isVoidResolvableFrom(subApp)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Round 44: an installed PnP runtime proves that `yarn install` ran at
  // least once, but it does NOT prove that `void` is currently on the
  // dependency graph. A branch switch / `package.json` edit that removes
  // `void` leaves stale `.pnp.cjs` that still points at the old graph.
  // `isVoidResolvableFrom` must actually spawn a probe under the PnP
  // loaders and observe `require.resolve('void')` succeeding.
  it('returns false when the PnP probe for `require.resolve("void")` fails (stale .pnp.cjs)', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-pnp-stale-'));
    try {
      writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(root, '.yarn'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'install-state.gz'), '');

      // Probe spawn for `require.resolve('void')` returns a non-zero
      // exit — void is not in the current PnP graph.
      mockSpawnSync.mockImplementationOnce(
        (_command: unknown, _args: unknown, _options: unknown) => ({
          status: 1,
          stdout: '',
          stderr: '',
        }),
      );

      expect(isVoidResolvableFrom(root)).toBe(false);

      // Verify the probe was actually spawned with the expected argv.
      const probeCalls = mockSpawnSync.mock.calls.filter(
        (call) =>
          Array.isArray(call[1]) &&
          (call[1] as unknown[])[0] === '-e' &&
          (call[1] as unknown[])[1] === "require.resolve('void')",
      );
      expect(probeCalls.length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns true when the PnP probe for `require.resolve("void")` succeeds', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-pnp-ok-'));
    try {
      writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(root, '.yarn'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'install-state.gz'), '');

      // Probe spawn returns 0 — void resolves in the current PnP graph.
      mockSpawnSync.mockImplementationOnce(
        (_command: unknown, _args: unknown, _options: unknown) => ({
          status: 0,
          stdout: '',
          stderr: '',
        }),
      );

      expect(isVoidResolvableFrom(root)).toBe(true);

      const probeCalls = mockSpawnSync.mock.calls.filter(
        (call) =>
          Array.isArray(call[1]) &&
          (call[1] as unknown[])[0] === '-e' &&
          (call[1] as unknown[])[1] === "require.resolve('void')",
      );
      expect(probeCalls.length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Round 45 (codex-connector review): when only `.pnp.loader.mjs` is
  // present (no `.pnp.cjs`), `buildDrizzleKitSpawnEnv` only injects
  // `--experimental-loader` and does NOT inject `--require`. A CJS
  // probe (`node -e "require.resolve('void')"`) therefore cannot see
  // the PnP loader and falsely reports "not resolvable". The probe
  // must switch to the ESM resolver — `import.meta.resolve('void')`
  // under `--input-type=module` — which goes through the loader's
  // `resolve` hook.
  it('uses an ESM probe when only `.pnp.loader.mjs` is present (loader-only PnP)', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-pnp-loader-only-'));
    try {
      writeFileSync(join(root, '.pnp.loader.mjs'), '// pnp loader\n');
      mkdirSync(join(root, '.yarn'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'install-state.gz'), '');

      mockSpawnSync.mockImplementationOnce(
        (_command: unknown, _args: unknown, _options: unknown) => ({
          status: 0,
          stdout: '',
          stderr: '',
        }),
      );

      expect(isVoidResolvableFrom(root)).toBe(true);

      // Only the ESM probe shape should have been spawned — NO CJS probe.
      const esmProbes = mockSpawnSync.mock.calls.filter(
        (call) =>
          Array.isArray(call[1]) &&
          (call[1] as unknown[])[0] === '--input-type=module' &&
          (call[1] as unknown[])[1] === '-e' &&
          (call[1] as unknown[])[2] === "import.meta.resolve('void')",
      );
      expect(esmProbes.length).toBe(1);
      const cjsProbes = mockSpawnSync.mock.calls.filter(
        (call) =>
          Array.isArray(call[1]) &&
          (call[1] as unknown[])[0] === '-e' &&
          (call[1] as unknown[])[1] === "require.resolve('void')",
      );
      expect(cjsProbes.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns false when the loader-only ESM probe fails (stale `.pnp.loader.mjs`)', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-pnp-loader-stale-'));
    try {
      writeFileSync(join(root, '.pnp.loader.mjs'), '// pnp loader\n');
      mkdirSync(join(root, '.yarn'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'install-state.gz'), '');

      mockSpawnSync.mockImplementationOnce(
        (_command: unknown, _args: unknown, _options: unknown) => ({
          status: 1,
          stdout: '',
          stderr: '',
        }),
      );

      expect(isVoidResolvableFrom(root)).toBe(false);

      const esmProbes = mockSpawnSync.mock.calls.filter(
        (call) =>
          Array.isArray(call[1]) &&
          (call[1] as unknown[])[0] === '--input-type=module' &&
          (call[1] as unknown[])[1] === '-e' &&
          (call[1] as unknown[])[2] === "import.meta.resolve('void')",
      );
      expect(esmProbes.length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still uses the CJS probe when both `.pnp.cjs` and `.pnp.loader.mjs` are present', () => {
    // Common Yarn 4 shape: both files exist. `.pnp.cjs` is the primary
    // runtime and the CJS probe is idiomatic under `--require`. Pin
    // this so a future refactor doesn't silently flip the probe
    // shape for the common case.
    const root = mkdtempSync(join(tmpdir(), 'void-init-pnp-both-'));
    try {
      writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
      writeFileSync(join(root, '.pnp.loader.mjs'), '// pnp loader\n');
      mkdirSync(join(root, '.yarn'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'install-state.gz'), '');

      mockSpawnSync.mockImplementationOnce(
        (_command: unknown, _args: unknown, _options: unknown) => ({
          status: 0,
          stdout: '',
          stderr: '',
        }),
      );

      expect(isVoidResolvableFrom(root)).toBe(true);

      const cjsProbes = mockSpawnSync.mock.calls.filter(
        (call) =>
          Array.isArray(call[1]) &&
          (call[1] as unknown[])[0] === '-e' &&
          (call[1] as unknown[])[1] === "require.resolve('void')",
      );
      expect(cjsProbes.length).toBe(1);
      const esmProbes = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && (call[1] as unknown[])[0] === '--input-type=module',
      );
      expect(esmProbes.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Round 44: the `node_modules/void` ancestor walk must short-circuit
  // the PnP probe. When the hoisted node_modules is already present we
  // don't need to spawn a probe process at all.
  it('does not spawn the PnP probe when node_modules/void exists at start (even with PnP markers)', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-pnp-nm-'));
    try {
      mkdirSync(join(root, 'node_modules', 'void'), { recursive: true });
      writeFileSync(
        join(root, 'node_modules', 'void', 'package.json'),
        JSON.stringify({ name: 'void', version: '0.0.1' }, null, 2) + '\n',
      );
      // PnP markers also present — but node_modules walk should return
      // true first and avoid the probe entirely.
      writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(root, '.yarn'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'install-state.gz'), '');

      const probeCallsBefore = mockSpawnSync.mock.calls.filter(
        (call) =>
          Array.isArray(call[1]) &&
          (call[1] as unknown[])[0] === '-e' &&
          (call[1] as unknown[])[1] === "require.resolve('void')",
      ).length;

      expect(isVoidResolvableFrom(root)).toBe(true);

      const probeCallsAfter = mockSpawnSync.mock.calls.filter(
        (call) =>
          Array.isArray(call[1]) &&
          (call[1] as unknown[])[0] === '-e' &&
          (call[1] as unknown[])[1] === "require.resolve('void')",
      ).length;
      expect(probeCallsAfter).toBe(probeCallsBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Round 46 (codex-connector review): a leaf-managed nested project
  // sitting inside an unrelated Yarn PnP monorepo must not inherit the
  // outer `.pnp.cjs`. `findInstalledYarnPnpRuntime` now stops at `start`
  // when the leaf has its own lockfile or Corepack pin. The node_modules
  // ancestor walk above already short-circuits when the leaf has an
  // installed `void`; this test covers the state BEFORE install, where
  // both branches must refuse to fall back to the outer graph.
  it('does not walk past a leaf-managed lockfile into an ancestor Yarn PnP monorepo', () => {
    const outer = mkdtempSync(join(tmpdir(), 'void-init-pnp-leaf-lock-'));
    try {
      // Ancestor: installed Yarn PnP monorepo with runtime + marker.
      writeFileSync(join(outer, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(outer, '.yarn'), { recursive: true });
      writeFileSync(join(outer, '.yarn', 'install-state.gz'), '');
      // Nested leaf npm project with its own lockfile. No node_modules
      // yet (fresh clone), no local PnP files — the gate must stop the
      // ancestor walk here instead of finding the outer `.pnp.cjs`.
      const leaf = join(outer, 'scratch', 'my-app');
      mkdirSync(leaf, { recursive: true });
      writeFileSync(join(leaf, 'package.json'), '{"name":"my-app"}\n');
      writeFileSync(join(leaf, 'package-lock.json'), '{}\n');

      const probesBefore = mockSpawnSync.mock.calls.length;
      expect(isVoidResolvableFrom(leaf)).toBe(false);
      // No PnP probe should have been spawned — `findInstalledYarnPnpRuntime`
      // must return undefined before we reach the probe branch.
      expect(mockSpawnSync.mock.calls.length).toBe(probesBefore);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  // Round 46 (codex follow-up): a `packageManager` Corepack pin at
  // a subpackage must NOT stop the ancestor walk. Yarn Berry workspace
  // members can legitimately carry their own `packageManager: "yarn@..."`
  // while still resolving through the workspace root's `.pnp.cjs`.
  // Treating the pin as leaf-managed would regress valid PnP monorepos.
  it('still walks to an ancestor `.pnp.cjs` when a subpackage has only a `packageManager` pin (no lockfile)', () => {
    const outer = mkdtempSync(join(tmpdir(), 'void-init-pnp-pkgmgr-ws-'));
    try {
      writeFileSync(join(outer, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(outer, '.yarn'), { recursive: true });
      writeFileSync(join(outer, '.yarn', 'install-state.gz'), '');
      // Workspace subpackage with its own `packageManager` pin — this
      // is a common shape for generator-scaffolded Yarn subpackages
      // and must NOT block the ancestor walk.
      const sub = join(outer, 'packages', 'app');
      mkdirSync(sub, { recursive: true });
      writeFileSync(
        join(sub, 'package.json'),
        JSON.stringify({ name: 'app', packageManager: 'yarn@4.5.3' }, null, 2) + '\n',
      );

      mockSpawnSync.mockImplementationOnce(
        (_command: unknown, _args: unknown, _options: unknown) => ({
          status: 0,
          stdout: '',
          stderr: '',
        }),
      );

      // Must resolve through the ancestor PnP graph — the probe fires
      // and reports success under the outer `.pnp.cjs`.
      expect(isVoidResolvableFrom(sub)).toBe(true);
      const probeCalls = mockSpawnSync.mock.calls.filter(
        (call) =>
          Array.isArray(call[1]) &&
          (call[1] as unknown[])[0] === '-e' &&
          (call[1] as unknown[])[1] === "require.resolve('void')",
      );
      expect(probeCalls.length).toBe(1);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
});

// Round 46 (codex-connector review): `buildDrizzleKitSpawnEnv` walked
// ancestors unconditionally, so a leaf-managed nested project inside an
// unrelated Yarn PnP monorepo would get the outer `.pnp.cjs` injected
// into `NODE_OPTIONS`. drizzle-kit then tried to resolve local deps
// through the outer graph and crashed. The gate in `findYarnPnpRuntime`
// must stop the walk at any directory that owns its own install.
describe('buildDrizzleKitSpawnEnv leaf-managed gate', () => {
  it('does not inject NODE_OPTIONS for a leaf project with a local lockfile inside a Yarn PnP monorepo', () => {
    const outer = mkdtempSync(join(tmpdir(), 'void-init-env-leaf-lock-'));
    const savedNodeOptions = process.env.NODE_OPTIONS;
    delete process.env.NODE_OPTIONS;
    try {
      writeFileSync(join(outer, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(outer, '.yarn'), { recursive: true });
      writeFileSync(join(outer, '.yarn', 'install-state.gz'), '');
      const leaf = join(outer, 'scratch', 'my-app');
      mkdirSync(leaf, { recursive: true });
      writeFileSync(join(leaf, 'package.json'), '{"name":"my-app"}\n');
      writeFileSync(join(leaf, 'package-lock.json'), '{}\n');

      const env = buildDrizzleKitSpawnEnv(leaf);
      // The returned env must NOT contain a NODE_OPTIONS that references
      // the ancestor PnP runtime — that would break local resolution.
      expect(env.NODE_OPTIONS).toBeUndefined();
    } finally {
      if (savedNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = savedNodeOptions;
      }
      rmSync(outer, { recursive: true, force: true });
    }
  });

  // Round 46 (codex follow-up): a subpackage that only carries a
  // `packageManager` Corepack pin is NOT proof of leaf-managed
  // ownership — Yarn workspace members legitimately do this. The gate
  // must still inject the ancestor PnP loader in that case. This
  // mirrors the `isVoidResolvableFrom` regression test above.
  it('still injects NODE_OPTIONS for a workspace subpackage that only has a `packageManager` pin', () => {
    const outer = mkdtempSync(join(tmpdir(), 'void-init-env-pkgmgr-ws-'));
    const savedNodeOptions = process.env.NODE_OPTIONS;
    delete process.env.NODE_OPTIONS;
    try {
      writeFileSync(join(outer, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(outer, '.yarn'), { recursive: true });
      writeFileSync(join(outer, '.yarn', 'install-state.gz'), '');
      const sub = join(outer, 'packages', 'app');
      mkdirSync(sub, { recursive: true });
      writeFileSync(
        join(sub, 'package.json'),
        JSON.stringify({ name: 'app', packageManager: 'yarn@4.5.3' }, null, 2) + '\n',
      );

      const env = buildDrizzleKitSpawnEnv(sub);
      expect(env.NODE_OPTIONS).toBeDefined();
      expect(env.NODE_OPTIONS).toContain(JSON.stringify(join(outer, '.pnp.cjs')));
    } finally {
      if (savedNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = savedNodeOptions;
      }
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it('still injects NODE_OPTIONS when local PnP files exist alongside a lockfile (local PnP precedence)', () => {
    // A real Yarn Berry project commits both `yarn.lock` AND `.pnp.cjs`
    // at the same directory. The local lockfile should NOT gate out
    // the local PnP runtime — local PnP files at `start` are
    // authoritative over the leaf-managed ownership check.
    const root = mkdtempSync(join(tmpdir(), 'void-init-env-local-pnp-'));
    const savedNodeOptions = process.env.NODE_OPTIONS;
    delete process.env.NODE_OPTIONS;
    try {
      writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
      writeFileSync(join(root, 'yarn.lock'), '# yarn lockfile v1\n');
      mkdirSync(join(root, '.yarn'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'install-state.gz'), '');

      const env = buildDrizzleKitSpawnEnv(root);
      expect(env.NODE_OPTIONS).toBeDefined();
      expect(env.NODE_OPTIONS).toContain('--require');
      expect(env.NODE_OPTIONS).toContain(JSON.stringify(join(root, '.pnp.cjs')));
    } finally {
      if (savedNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = savedNodeOptions;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still walks to an ancestor Yarn PnP monorepo for a true workspace subpackage (no local ownership)', () => {
    // Sanity: the common shape — a workspace subpackage with no
    // lockfile, no Corepack pin, no local PnP files — must still pick
    // up the ancestor's `.pnp.cjs` so drizzle-kit spawns under PnP.
    const outer = mkdtempSync(join(tmpdir(), 'void-init-env-monorepo-'));
    const savedNodeOptions = process.env.NODE_OPTIONS;
    delete process.env.NODE_OPTIONS;
    try {
      writeFileSync(join(outer, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(outer, '.yarn'), { recursive: true });
      writeFileSync(join(outer, '.yarn', 'install-state.gz'), '');
      const sub = join(outer, 'packages', 'app');
      mkdirSync(sub, { recursive: true });
      // Package manifest for the workspace member — NO lockfile, NO
      // packageManager field.
      writeFileSync(join(sub, 'package.json'), '{"name":"app"}\n');

      const env = buildDrizzleKitSpawnEnv(sub);
      expect(env.NODE_OPTIONS).toBeDefined();
      expect(env.NODE_OPTIONS).toContain(JSON.stringify(join(outer, '.pnp.cjs')));
    } finally {
      if (savedNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = savedNodeOptions;
      }
      rmSync(outer, { recursive: true, force: true });
    }
  });
});

describe('isScaffoldableEmptyProject', () => {
  it('returns true for an empty directory', () => {
    withTempDir((root) => {
      expect(isScaffoldableEmptyProject(root)).toBe(true);
    });
  });

  it('returns true for npm install -D void shape', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'my-app',
            devDependencies: {
              void: '^0.0.1',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(join(root, 'package-lock.json'), '{}\n');

      expect(isScaffoldableEmptyProject(root)).toBe(true);
    });
  });

  it('returns true when only void and a single Pages adapter are installed', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'my-app',
            devDependencies: {
              void: 'npm:@void-sdk/void@^0.2.3',
              '@void/react': 'npm:@void-sdk/react@^0.2.3',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");

      expect(isScaffoldableEmptyProject(root)).toBe(true);
    });
  });

  it('returns false when app files already exist', () => {
    withTempDir((root) => {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'main.ts'), "console.log('x');\n");
      expect(isScaffoldableEmptyProject(root)).toBe(false);
    });
  });

  it('returns false when package has non-void dependencies', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'my-app',
            devDependencies: {
              void: '^0.0.1',
              vite: '^8.0.0',
            },
          },
          null,
          2,
        ) + '\n',
      );

      expect(isScaffoldableEmptyProject(root)).toBe(false);
    });
  });

  it('scaffolds a React Pages starter with D1 in an empty directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      mockSelect
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('sqlite')
        .mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(pkg.dependencies.react).toBeDefined();
      expect(pkg.dependencies['react-dom']).toBeDefined();
      expect(pkg.dependencies.hono).toBeDefined();
      expect(pkg.devDependencies.vite).toBeDefined();
      expect(pkg.devDependencies.void).toBeDefined();
      expect(pkg.devDependencies.typescript).toBeDefined();
      expect(pkg.devDependencies['@void/react']).toBeDefined();
      expect(pkg.devDependencies['@types/react']).toBeDefined();
      expect(pkg.devDependencies['@types/react-dom']).toBeDefined();

      const reactViteConfig = readFileSync(join(root, 'vite.config.ts'), 'utf-8');
      expect(reactViteConfig).toContain('from "@void/react/plugin"');
      expect(reactViteConfig).toContain('voidReact()');
      expect(readFileSync(join(root, 'pages', 'index.tsx'), 'utf-8')).toContain('Welcome to Void');
      expect(readFileSync(join(root, 'pages', 'index.server.ts'), 'utf-8')).toContain(
        'import { messages } from "@schema";',
      );
      expect(readFileSync(join(root, 'routes', 'api', 'hello.ts'), 'utf-8')).toContain(
        'export const GET = defineHandler',
      );
      expect(readFileSync(join(root, 'db', 'schema.ts'), 'utf-8')).toContain(
        'from "void/schema-d1"',
      );
      expect(readFileSync(join(root, 'db', 'seed.ts'), 'utf-8')).toContain('defineSeed');
      expect(listMigrationSqlFiles(root)).toEqual(['0000_generated.sql']);
      expect(readFileSync(join(root, 'db', 'migrations', '0000_generated.sql'), 'utf-8')).toContain(
        'CREATE TABLE',
      );
      expect(
        readFileSync(join(root, 'db', 'migrations', 'meta', '_journal.json'), 'utf-8'),
      ).toContain('"entries"');

      expect(() => readFileSync(join(root, 'routes', 'api', 'hello.get.ts'), 'utf-8')).toThrow(
        /ENOENT/,
      );
      expect(() => readFileSync(join(root, 'index.html'), 'utf-8')).toThrow(/ENOENT/);
      expect(() => readFileSync(join(root, 'src', 'main.ts'), 'utf-8')).toThrow(/ENOENT/);
      expect(JSON.parse(readFileSync(join(root, 'void.json'), 'utf-8'))).toEqual({
        worker: {
          compatibility_date: getTodayCompatDate(),
        },
      });
      expect(() =>
        readFileSync(join(root, 'db', 'migrations', '0000_initial.sql'), 'utf-8'),
      ).toThrow(/ENOENT/);

      const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf-8'));
      expect(tsconfig.compilerOptions.jsx).toBe('react-jsx');
      expect(tsconfig.include).toContain('pages');
      expect(tsconfig.include).toContain('db');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('scaffolds a Vue Pages starter with PostgreSQL config', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      mockSelect
        .mockResolvedValueOnce('vue')
        .mockResolvedValueOnce('postgresql')
        .mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(pkg.dependencies.vue).toBeDefined();
      expect(pkg.devDependencies['@void/vue']).toBeDefined();
      expect(pkg.devDependencies.void).toBeDefined();

      expect(JSON.parse(readFileSync(join(root, 'void.json'), 'utf-8'))).toEqual({
        database: 'pg',
        worker: {
          compatibility_date: getTodayCompatDate(),
        },
      });

      const vueViteConfig = readFileSync(join(root, 'vite.config.ts'), 'utf-8');
      expect(vueViteConfig).toContain('from "@void/vue/plugin"');
      expect(vueViteConfig).toContain('voidVue()');
      expect(readFileSync(join(root, 'pages', 'index.vue'), 'utf-8')).toContain('Welcome to Void');
      expect(readFileSync(join(root, 'db', 'schema.ts'), 'utf-8')).toContain(
        'from "void/schema-pg"',
      );
      expect(readFileSync(join(root, 'db', 'seed.ts'), 'utf-8')).toContain('defineSeed');
      expect(listMigrationSqlFiles(root)).toEqual(['0000_generated.sql']);
      expect(readFileSync(join(root, 'db', 'migrations', '0000_generated.sql'), 'utf-8')).toContain(
        'CREATE TABLE "messages"',
      );

      const frameworkPrompt = mockSelect.mock.calls[0]?.[0];
      expect(frameworkPrompt.message).toBe('Choose a Pages framework to scaffold:');
      expect(frameworkPrompt.options).toEqual([
        {
          value: 'react',
          label: 'React',
          hint: 'TSX Pages starter with the React adapter.',
        },
        {
          value: 'vue',
          label: 'Vue',
          hint: 'Vue SFC Pages starter with the Vue adapter.',
        },
        {
          value: 'svelte',
          label: 'Svelte',
          hint: 'Svelte 5 Pages starter with the Svelte adapter.',
        },
        {
          value: 'solid',
          label: 'Solid',
          hint: 'Fine-grained TSX Pages starter with the Solid adapter.',
        },
      ]);

      const starterPrompt = mockSelect.mock.calls[1]?.[0];
      expect(starterPrompt.message).toBe('Choose a Pages starter:');
      expect(starterPrompt.options).toEqual([
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
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('scaffolds a static Pages starter without database files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      mockSelect
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('static')
        .mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(pkg.dependencies.react).toBeDefined();
      expect(pkg.dependencies['react-dom']).toBeDefined();
      expect(pkg.dependencies.hono).toBeDefined();
      expect(pkg.devDependencies.void).toBeDefined();
      expect(pkg.devDependencies['@void/react']).toBeDefined();

      expect(readFileSync(join(root, 'pages', 'index.tsx'), 'utf-8')).toContain(
        'no database or server code yet',
      );

      expect(() => readFileSync(join(root, 'pages', 'index.server.ts'), 'utf-8')).toThrow();
      expect(() => readFileSync(join(root, 'routes', 'api', 'hello.ts'), 'utf-8')).toThrow();
      expect(() => readFileSync(join(root, 'db', 'schema.ts'), 'utf-8')).toThrow();
      expect(() => readFileSync(join(root, 'db', 'seed.ts'), 'utf-8')).toThrow();
      expect(() =>
        readFileSync(join(root, 'db', 'migrations', '0000_generated.sql'), 'utf-8'),
      ).toThrow();
      expect(JSON.parse(readFileSync(join(root, 'void.json'), 'utf-8'))).toEqual({
        worker: {
          compatibility_date: getTodayCompatDate(),
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates .gitignore with Void defaults during targeted setup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      await runInitCommand(root, { tsconfig: true, github: false, agents: false });

      const gitignore = readFileSync(join(root, '.gitignore'), 'utf-8');
      expect(gitignore).toContain('node_modules');
      expect(gitignore).toContain('.void');
      expect(gitignore).toContain('.wrangler');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('appends missing Void defaults to an existing .gitignore', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(root, '.gitignore'), 'node_modules\ncustom-cache\n');

      await runInitCommand(root, { tsconfig: true, github: false, agents: false });

      const gitignore = readFileSync(join(root, '.gitignore'), 'utf-8');
      expect(gitignore).toContain('custom-cache');
      expect(gitignore).toContain('.void');
      expect(gitignore).toContain('.wrangler');
      expect(gitignore.match(/^node_modules$/gm)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('parses tsconfig.json with JSONC comments', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'tsconfig.json'),
        `{
  // This is a comment
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true
  }
}\n`,
      );

      await runInitCommand(root, { tsconfig: true, github: false, agents: false });

      const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf-8'));
      expect(tsconfig.extends).toBeDefined();
      expect(tsconfig.compilerOptions.types).toContain('void/env');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the preinstalled adapter to scaffold an empty project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'my-app',
            private: true,
            devDependencies: {
              void: 'npm:@void-sdk/void@^0.2.3',
              '@void/react': 'npm:@void-sdk/react@^0.2.3',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");

      mockSelect.mockResolvedValueOnce('sqlite').mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(pkg.scripts.dev).toBe('vite');
      expect(pkg.devDependencies.void).toBe('npm:@void-sdk/void@^0.2.3');
      expect(pkg.devDependencies['@void/react']).toBe('npm:@void-sdk/react@^0.2.3');
      expect(pkg.pnpm.onlyBuiltDependencies).toEqual(
        expect.arrayContaining(['better-sqlite3', 'esbuild', 'workerd']),
      );

      const reactViteConfig = readFileSync(join(root, 'vite.config.ts'), 'utf-8');
      expect(reactViteConfig).toContain('from "@void/react/plugin"');
      expect(reactViteConfig).toContain('voidReact()');

      expect(mockSelect.mock.calls[0]?.[0].message).toBe('Choose a Pages starter:');
      expect(mockSelect).not.toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Choose a Pages framework to scaffold:' }),
      );
      expect(mockSpawnSync).toHaveBeenCalledWith(
        'pnpm',
        ['install'],
        expect.objectContaining({
          cwd: root,
          stdio: 'inherit',
          shell: process.platform === 'win32',
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes the pg config when switching back to implicit sqlite', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(root, 'void.json'), JSON.stringify({ database: 'pg' }, null, 2) + '\n');
      mockSelect.mockResolvedValueOnce('sqlite').mockResolvedValueOnce('generic');
      mockConfirm
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(JSON.parse(readFileSync(join(root, 'void.json'), 'utf-8'))).toEqual({
        worker: {
          compatibility_date: getTodayCompatDate(),
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves other void.json fields when switching from pg to sqlite', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'void.json'),
        JSON.stringify(
          {
            database: 'pg',
            routing: {
              prerender: ['/'],
            },
          },
          null,
          2,
        ) + '\n',
      );
      mockSelect.mockResolvedValueOnce('sqlite').mockResolvedValueOnce('generic');
      mockConfirm
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(JSON.parse(readFileSync(join(root, 'void.json'), 'utf-8'))).toEqual({
        routing: {
          prerender: ['/'],
        },
        worker: {
          compatibility_date: getTodayCompatDate(),
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('removes the pg config when choosing no database yet', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(root, 'void.json'), JSON.stringify({ database: 'pg' }, null, 2) + '\n');
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(JSON.parse(readFileSync(join(root, 'void.json'), 'utf-8'))).toEqual({
        worker: {
          compatibility_date: getTodayCompatDate(),
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('can log in and create a project during init', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      mockSelect
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('sqlite')
        .mockResolvedValueOnce('generic')
        .mockResolvedValueOnce('github');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      mockText.mockResolvedValueOnce('my-live-app');
      mockCreateProject.mockResolvedValueOnce({ id: 'proj_live', slug: 'my-live-app' });

      await runInitCommand(root);

      expect(mockConfirm.mock.calls[1]?.[0]).toMatchObject({
        message: 'Set up your Void project now? (log in + link project)',
      });
      expect(mockRunLogin).toHaveBeenCalledWith('github');
      expect(mockSaveToken).toHaveBeenCalledWith('token_123');
      expect(mockListProjects).toHaveBeenCalledOnce();
      expect(mockCreateProject).toHaveBeenCalledWith('my-live-app');
      expect(JSON.parse(readFileSync(join(root, '.void', 'project.json'), 'utf-8'))).toEqual({
        projectId: 'proj_live',
        slug: 'my-live-app',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('can link an existing project during init without re-authenticating', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      mockGetToken.mockReturnValue('existing_token');
      mockListProjects.mockResolvedValueOnce([
        {
          id: 'proj_456',
          user_id: 'user_1',
          slug: 'existing-app',
          type: 'worker',
          created_at: '2026-03-27T00:00:00.000Z',
          custom_domain: null,
        },
      ]);
      mockSelect
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('sqlite')
        .mockResolvedValueOnce('generic')
        .mockResolvedValueOnce('proj_456');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

      await runInitCommand(root);

      expect(mockConfirm.mock.calls[1]?.[0]).toMatchObject({
        message: 'Link your Void project now?',
      });
      expect(mockRunLogin).not.toHaveBeenCalled();
      expect(mockSaveToken).not.toHaveBeenCalled();
      expect(mockCreateProject).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(join(root, '.void', 'project.json'), 'utf-8'))).toEqual({
        projectId: 'proj_456',
        slug: 'existing-app',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('defaults the database prompt to D1 when no database is configured', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'my-app',
            devDependencies: {
              void: '^0.0.1',
              vite: '^8.0.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const databasePrompt = mockSelect.mock.calls[0]?.[0];
      expect(databasePrompt.message).toBe('Choose a database setup for this project:');
      expect(databasePrompt.initialValue).toBe('sqlite');
      expect(databasePrompt.options).toEqual([
        {
          value: 'sqlite',
          label: 'D1 (SQLite)',
          hint: 'Zero-config and fully managed by Void; best for prototyping and read-heavy apps.',
        },
        {
          value: 'postgresql',
          label: 'PostgreSQL',
          hint: 'Bring your own Postgres via Hyperdrive; best for write-heavy apps, complex queries, or existing infra.',
        },
        {
          value: 'none',
          label: 'No Database Yet',
          hint: 'Skip database setup for now. You can add D1 or PostgreSQL later as your app grows.',
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips install after demo scaffold when node_modules/void is already populated (workspace subpackage)', async () => {
    // Regression for void-sdk/void#6 round 25: round 24 gated the post-
    // demo install on `ensureVoidDependency` mutating `package.json` so
    // workspace subpackages with a `workspace:` spec and no lockfile
    // wouldn't break on a spurious `npm install` that aborts on
    // `workspace:` ranges. `node_modules/void` is already populated here
    // via the parent workspace install, so `generateStarterMigration`
    // can resolve `void/schema-d1` without re-running install. This
    // path must stay silent on the package manager — no install call.
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'workspace-sub',
            private: true,
            type: 'module',
            devDependencies: {
              void: 'workspace:../packages/void',
              // `vite` keeps `isScaffoldableEmptyProject` from taking the
              // Pages starter branch so we fall through to the demo prompt.
              vite: '^8.0.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      // Pre-populate node_modules/void so `voidResolvable` is true.
      mkdirSync(join(root, 'node_modules', 'void'), { recursive: true });
      writeFileSync(
        join(root, 'node_modules', 'void', 'package.json'),
        JSON.stringify({ name: 'void', version: '0.0.0' }, null, 2) + '\n',
      );
      // No lockfile, no packageManager — `detectProjectState` falls back
      // to `npm`, which would blow up on the `workspace:` spec if install
      // actually ran.
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('generic');
      // Demo confirm → true; GitHub Actions confirm → false; deploy-setup
      // confirm falls through to the mock default (undefined).
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await runInitCommand(root);

      // The install call for a workspace subpackage must NOT fire: the
      // post-demo install is gated on (a) scaffoldDemo mutating
      // package.json OR (b) node_modules/void being missing. Neither is
      // true here, so `installProjectDependencies` is skipped entirely.
      const installCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][0] === 'install',
      );
      expect(installCalls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips install after demo scaffold when void is hoisted at the workspace root (ancestor node_modules)', async () => {
    // Regression for void-sdk/void#6 round 26: round 25's gate checked
    // only `<root>/node_modules/void/package.json`. Workspace subpackages
    // typically don't have `void` in their own `node_modules` — the
    // package manager hoists it to the workspace root. Node's module
    // resolution walks up the directory tree, so drizzle-kit can still
    // `require('void/schema-d1')` from the subpackage via the ancestor
    // install. The narrow existsSync check missed that and forced a
    // spurious subpackage install (reintroducing the round-24 regression
    // in a different shape). The fix walks the ancestor chain so the
    // hoisted case is correctly recognized as "already installed".
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      // Workspace root: stub `void` package in the root's `node_modules`.
      // No `package.json` is needed at the workspace root for the walk
      // itself — `isVoidResolvableFrom` only checks `<dir>/node_modules/
      // void/package.json` at each level.
      mkdirSync(join(wsroot, 'node_modules', 'void'), { recursive: true });
      writeFileSync(
        join(wsroot, 'node_modules', 'void', 'package.json'),
        JSON.stringify({ name: 'void', version: '0.0.0' }, null, 2) + '\n',
      );

      // Subpackage: has `package.json` but NO local `node_modules/void`.
      const subpkgRoot = join(wsroot, 'subpkg');
      mkdirSync(subpkgRoot, { recursive: true });
      writeFileSync(
        join(subpkgRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'workspace-sub-hoisted',
            private: true,
            type: 'module',
            devDependencies: {
              void: 'workspace:../packages/void',
              // Keep us out of the Pages starter branch so we hit the
              // demo prompt.
              vite: '^8.0.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      // Install MUST NOT be invoked: `void` is resolvable from
      // `subpkgRoot` via the ancestor `wsroot/node_modules`, so the demo
      // gate treats the subpackage as already installed.
      const installCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][0] === 'install',
      );
      expect(installCalls).toHaveLength(0);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('runs install after demo scaffold when void resolves from an ancestor but the child package.json was mutated', async () => {
    // Regression history for void-sdk/void#6:
    //   - Round 24 forced install whenever `ensureVoidDependency` mutated
    //     the local `package.json`.
    //   - Round 27 tightened that to "mutated OR not resolvable", which
    //     broke round-24's test because workspace subpackages with
    //     `workspace:` specs reject `npm install`.
    //   - Round 28 (previous shape of this test) flipped the gate for any
    //     ancestor-hoisted `void`, asserting install was SKIPPED.
    //   - Round 30 tightened workspace detection further: the skip branch
    //     now requires an actual workspace marker (`pnpm-workspace.yaml`
    //     or `package.json#workspaces`) AND declared membership via
    //     `isWorkspaceSubpackage`. The setup below has NEITHER — the
    //     parent is a plain directory with a hoisted `node_modules/void`,
    //     not a workspace root.
    //   - Round 34 (this test): with round-30's strictness in place,
    //     skipping install for a nested non-workspace app leaves the
    //     child's `package.json` disagreeing with any lockfile the child
    //     may already have. The next frozen-install fails the integrity
    //     check. The correct behavior is "install whenever we changed the
    //     child's `package.json`, unless the workspace-subpackage branches
    //     above this one already decided to skip." In a non-workspace
    //     nesting, that means install runs and reconciles the child's
    //     lockfile with the new `void` entry.
    const parentRoot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      // Parent dir: hoisted `node_modules/void`, but NOT a workspace
      // root. No `pnpm-workspace.yaml`, no `package.json#workspaces`.
      mkdirSync(join(parentRoot, 'node_modules', 'void'), { recursive: true });
      writeFileSync(
        join(parentRoot, 'node_modules', 'void', 'package.json'),
        JSON.stringify({ name: 'void', version: '0.0.0' }, null, 2) + '\n',
      );

      // Child app: `package.json` does NOT declare `void` yet.
      // `ensureVoidDependency` will write the alias during `scaffoldDemo`.
      const childRoot = join(parentRoot, 'subpkg');
      mkdirSync(childRoot, { recursive: true });
      writeFileSync(
        join(childRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'nested-hoisted-app',
            private: true,
            type: 'module',
            devDependencies: {
              // Keep us out of the Pages starter branch so we hit the
              // demo prompt. No `void` declared here — scaffoldDemo
              // (via ensureVoidDependency) must add it.
              vite: '^8.0.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      // Signal npm via a lockfile so the install invocation is
      // unambiguous.
      writeFileSync(join(childRoot, 'package-lock.json'), '{}\n');
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await runInitCommand(childRoot);

      // The alias WAS written to the child's own package.json —
      // `ensureVoidDependency` declares it so post-install state
      // matches the new dependency.
      const updatedPkg = JSON.parse(readFileSync(join(childRoot, 'package.json'), 'utf-8'));
      const voidSpec =
        updatedPkg.devDependencies?.void ??
        updatedPkg.dependencies?.void ??
        updatedPkg.peerDependencies?.void;
      expect(typeof voidSpec).toBe('string');
      expect(voidSpec.length).toBeGreaterThan(0);

      // Install MUST be invoked: the parent is not a workspace root, so
      // the workspace-subpackage skip branches don't apply, and the
      // child's package.json now declares a new dep that the child's
      // lockfile doesn't know about yet.
      const installCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][0] === 'install',
      );
      expect(installCalls.length).toBeGreaterThan(0);

      // The "Workspace subpackage" note MUST NOT fire — there's no
      // workspace root above the child.
      const noteCalls = mockNote.mock.calls;
      const matching = noteCalls.filter((call) => call[1] === 'Workspace subpackage');
      expect(matching).toHaveLength(0);
    } finally {
      rmSync(parentRoot, { recursive: true, force: true });
    }
  });

  it('skips install and starter migration in a fresh workspace subpackage', async () => {
    // Regression for void-sdk/void#6 round 29: a fresh clone of a
    // monorepo (no lockfile anywhere, no `node_modules` populated yet)
    // running `void init` inside a workspace subpackage used to hit the
    // round-28 gate as "void not resolvable" (ancestor walk finds no
    // `node_modules/void`) and force an `npm install`. But the
    // subpackage's own `package.json` typically declares `workspace:`
    // specs, and `detectProjectState` falls back to `npm`, so that
    // install aborts, cancelling the whole init flow mid-way. The fix
    // detects the workspace-subpackage shape via `findWorkspaceRoot`
    // (pnpm-workspace.yaml or parent `package.json` with a
    // `workspaces` field) and, when no ancestor `node_modules/void`
    // exists, skips BOTH the install AND `generateStarterMigration`
    // — surfacing a `note()` that tells the user how to finish.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      // Workspace root: pnpm-workspace.yaml, NO node_modules.
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

      // Subpackage: has `package.json` declaring `void` as a
      // `workspace:` spec and no local node_modules.
      const subpkgRoot = join(wsroot, 'packages', 'app');
      mkdirSync(subpkgRoot, { recursive: true });
      writeFileSync(
        join(subpkgRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'workspace-fresh-sub',
            private: true,
            type: 'module',
            devDependencies: {
              void: 'workspace:*',
              // `vite` keeps `isScaffoldableEmptyProject` from taking the
              // Pages starter branch so we fall through to the demo prompt.
              vite: '^8.0.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      // Install MUST NOT be invoked — running `npm install` here would
      // abort on the `workspace:*` spec.
      const installCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][0] === 'install',
      );
      expect(installCalls).toHaveLength(0);

      // `generateStarterMigration` MUST NOT spawn drizzle-kit — there's
      // no `node_modules` yet to resolve `void/schema-d1` through.
      const drizzleCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][1] === 'generate',
      );
      expect(drizzleCalls).toHaveLength(0);

      // The alias write from `scaffoldDemo` still landed in the
      // subpackage's `package.json` so the next real workspace-root
      // install picks up the dep.
      const updatedPkg = JSON.parse(readFileSync(join(subpkgRoot, 'package.json'), 'utf-8'));
      const voidSpec =
        updatedPkg.devDependencies?.void ??
        updatedPkg.dependencies?.void ??
        updatedPkg.peerDependencies?.void;
      expect(typeof voidSpec).toBe('string');
      expect(voidSpec.length).toBeGreaterThan(0);

      // The user-facing `note()` was emitted with "Workspace subpackage".
      const noteCalls = mockNote.mock.calls;
      const matching = noteCalls.filter((call) => call[1] === 'Workspace subpackage');
      expect(matching.length).toBeGreaterThan(0);
      // And the body mentions the next-step instructions.
      const body = String(matching[0][0]);
      expect(body).toMatch(/Scaffolded the starter demo/);
      expect(body).toMatch(/void db generate/);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('skips install and starter migration in a fresh workspace subpackage (npm workspaces root)', async () => {
    // Symmetric round-29 case: workspace root marker is a parent
    // `package.json` with a top-level `workspaces` field (npm/yarn/bun
    // workspaces shape, not pnpm). `findWorkspaceRoot` must still
    // detect the subpackage so the install/migration skip applies.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(wsroot, 'package.json'),
        JSON.stringify(
          {
            name: 'ws-root',
            private: true,
            workspaces: ['packages/*'],
          },
          null,
          2,
        ) + '\n',
      );

      const subpkgRoot = join(wsroot, 'packages', 'app');
      mkdirSync(subpkgRoot, { recursive: true });
      writeFileSync(
        join(subpkgRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'workspace-npm-sub',
            private: true,
            type: 'module',
            devDependencies: {
              void: 'workspace:^0.2.3',
              vite: '^8.0.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      const installCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][0] === 'install',
      );
      expect(installCalls).toHaveLength(0);

      const drizzleCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][1] === 'generate',
      );
      expect(drizzleCalls).toHaveLength(0);

      const noteCalls = mockNote.mock.calls;
      const matching = noteCalls.filter((call) => call[1] === 'Workspace subpackage');
      expect(matching.length).toBeGreaterThan(0);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('emits a lockfile-sync note when void is hoisted and scaffoldDemo mutated package.json in a workspace subpackage', async () => {
    // Regression for void-sdk/void#6 round 33: the hoisted-void +
    // workspace-subpackage branch of the post-demo install gate used
    // to leave the user silently broken. `scaffoldDemo` (via
    // `ensureVoidDependency`) writes a new `void` entry into the
    // subpackage's `package.json`, and because `void` was already
    // resolvable via an ancestor `node_modules/void`, the gate hit
    // the "do nothing" fall-through — no install, no note, and the
    // workspace lockfile now disagrees with `package.json`. The next
    // `pnpm install --frozen-lockfile` (or any CI install) fails the
    // integrity check. Round 33 adds a note pointing at the workspace
    // root so the user knows to re-run their workspace install, and
    // still skips `generateStarterMigration` for consistency with
    // the round-29 workspace-subpackage branch.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      // Workspace root: `pnpm-workspace.yaml` with `packages/*` AND a
      // hoisted `node_modules/void` (→ `isVoidResolvableFrom` returns
      // true via the ancestor walk).
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      mkdirSync(join(wsroot, 'node_modules', 'void'), { recursive: true });
      writeFileSync(
        join(wsroot, 'node_modules', 'void', 'package.json'),
        JSON.stringify({ name: 'void', version: '0.0.0' }, null, 2) + '\n',
      );

      // Subpackage: `package.json` does NOT declare `void` yet, so
      // `ensureVoidDependency` will mutate it during `scaffoldDemo`.
      const subpkgRoot = join(wsroot, 'packages', 'my-app');
      mkdirSync(subpkgRoot, { recursive: true });
      writeFileSync(
        join(subpkgRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'workspace-hoisted-sub',
            private: true,
            type: 'module',
            devDependencies: {
              // Keep us out of the Pages starter branch so we hit the
              // demo prompt. No `void` declared here — scaffoldDemo
              // (via ensureVoidDependency) must add it.
              vite: '^8.0.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      // `scaffoldDemo` ran — the subpackage's `package.json` now
      // declares a `void` dep.
      const updatedPkg = JSON.parse(readFileSync(join(subpkgRoot, 'package.json'), 'utf-8'));
      const voidSpec =
        updatedPkg.devDependencies?.void ??
        updatedPkg.dependencies?.void ??
        updatedPkg.peerDependencies?.void;
      expect(typeof voidSpec).toBe('string');
      expect(voidSpec.length).toBeGreaterThan(0);

      // Install MUST NOT be invoked — we're a workspace subpackage
      // and a subpackage `npm install` would break on the
      // `workspace:` specs in sibling packages.
      const installCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][0] === 'install',
      );
      expect(installCalls).toHaveLength(0);

      // drizzle-kit MUST NOT be invoked — we skip the starter
      // migration because the workspace lockfile is now stale and
      // emitting a migration against a drifted workspace invites
      // confusing state mismatches.
      const drizzleCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][1] === 'generate',
      );
      expect(drizzleCalls).toHaveLength(0);

      // The user-facing `note()` was emitted with
      // `'Workspace subpackage'` title and the body mentions lockfile
      // sync (so the user knows to re-run the workspace install).
      const noteCalls = mockNote.mock.calls;
      const matching = noteCalls.filter((call) => call[1] === 'Workspace subpackage');
      expect(matching.length).toBeGreaterThan(0);
      const body = String(matching[0][0]);
      expect(body).toMatch(/lockfile/);
      expect(body).toMatch(/void db generate/);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('runs install for a standalone scratch app nested under a pnpm workspace ancestor', async () => {
    // Round 30: `findWorkspaceRoot` only walks ancestors looking for a
    // `pnpm-workspace.yaml` / `package.json#workspaces` marker — it
    // doesn't verify that `root` is actually a declared member of that
    // workspace. A standalone scratch app at `<wsroot>/scratch/my-app`
    // under a workspace that only declares `packages/*` is NOT a
    // subpackage, and treating it as one skipped the demo install +
    // `generateStarterMigration` and left the user with unresolved
    // `void` imports. The membership check fixes that: non-members
    // fall through to the fresh-clone install branch.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      // Workspace root: pnpm-workspace.yaml with `packages/*` only.
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

      // Standalone nested app: under `scratch/`, not `packages/`.
      const subpkgRoot = join(wsroot, 'scratch', 'my-app');
      mkdirSync(subpkgRoot, { recursive: true });
      writeFileSync(
        join(subpkgRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'standalone-scratch-app',
            private: true,
            type: 'module',
            devDependencies: {
              void: '^0.0.1',
              vite: '^8.0.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      // Signal npm via lockfile so install is unambiguous.
      writeFileSync(join(subpkgRoot, 'package-lock.json'), '{}\n');
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      // Install MUST have been invoked — the app is not a declared
      // member of `packages/*`, so the workspace-skip branch must not
      // fire.
      const installCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][0] === 'install',
      );
      expect(installCalls.length).toBeGreaterThan(0);

      // drizzle-kit generate was invoked — the initial migration was
      // scaffolded via `generateStarterMigration`.
      const drizzleCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][1] === 'generate',
      );
      expect(drizzleCalls.length).toBeGreaterThan(0);

      // The "Workspace subpackage" note MUST NOT have been emitted.
      const noteCalls = mockNote.mock.calls;
      const matching = noteCalls.filter((call) => call[1] === 'Workspace subpackage');
      expect(matching).toHaveLength(0);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('runs install for a standalone scratch app nested under an npm workspaces ancestor', async () => {
    // Symmetric round-30 case: workspace root marker is a parent
    // `package.json` with a `workspaces: ["packages/*"]` array (npm/
    // yarn/bun shape, not pnpm). A non-member standalone app under
    // `scratch/` must also fall through to the install branch.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(wsroot, 'package.json'),
        JSON.stringify(
          {
            name: 'ws-root',
            private: true,
            workspaces: ['packages/*'],
          },
          null,
          2,
        ) + '\n',
      );

      const subpkgRoot = join(wsroot, 'scratch', 'my-app');
      mkdirSync(subpkgRoot, { recursive: true });
      writeFileSync(
        join(subpkgRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'standalone-npm-scratch-app',
            private: true,
            type: 'module',
            devDependencies: {
              void: '^0.0.1',
              vite: '^8.0.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(join(subpkgRoot, 'package-lock.json'), '{}\n');
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      const installCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][0] === 'install',
      );
      expect(installCalls.length).toBeGreaterThan(0);

      const drizzleCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][1] === 'generate',
      );
      expect(drizzleCalls.length).toBeGreaterThan(0);

      const noteCalls = mockNote.mock.calls;
      const matching = noteCalls.filter((call) => call[1] === 'Workspace subpackage');
      expect(matching).toHaveLength(0);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('runs install after demo scaffold when node_modules/void is missing (fresh clone)', async () => {
    // Regression for void-sdk/void#6 round 25: round 24 over-corrected by
    // only forcing install when `ensureVoidDependency` mutated
    // `package.json`. On a fresh clone of a regular project that already
    // declares `void` in `package.json` but has no `node_modules` yet,
    // that meant install was skipped and `generateStarterMigration`
    // spawned drizzle-kit against a project where `void/schema-d1`
    // couldn't resolve at runtime. The fix forces install when
    // `node_modules/void/package.json` is absent, so drizzle-kit can
    // resolve the schema import after the post-demo install.
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'fresh-clone',
            private: true,
            type: 'module',
            devDependencies: {
              void: '^0.0.1',
              // `vite` keeps `isScaffoldableEmptyProject` from taking the
              // Pages starter branch so we fall through to the demo prompt.
              vite: '^8.0.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      // Signal npm via lockfile. No `node_modules` directory — drizzle-
      // kit couldn't resolve `void/schema-d1` without an install first.
      writeFileSync(join(root, 'package-lock.json'), '{}\n');
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await runInitCommand(root);

      // Install MUST have been invoked for the fresh-clone case so
      // `node_modules/void` is populated before `generateStarterMigration`
      // spawns drizzle-kit.
      const installCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][0] === 'install',
      );
      expect(installCalls.length).toBeGreaterThan(0);
      // Sanity: the first install call uses `npm` (our lockfile signal).
      expect(installCalls[0][0]).toBe('npm');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs starter migration with injected PnP NODE_OPTIONS in a Yarn Berry PnP project', async () => {
    // Round 39: Yarn Berry PnP projects no longer skip the starter
    // migration. `generateStarterMigration()` now injects the PnP
    // loaders into the spawned child's `NODE_OPTIONS` via
    // `buildDrizzleKitSpawnEnv`, matching what `gen.ts:runMigration`
    // does — so `drizzle-kit generate` resolves `void/schema-d1`
    // correctly even when there is no `node_modules` tree.
    //
    // Rounds 31/32 used to emit a "Yarn PnP" note telling the user to
    // run `yarn void db generate` manually. That note is now gone —
    // the init flow completes the migration itself.
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'yarn-pnp-app',
            private: true,
            type: 'module',
            packageManager: 'yarn@4.5.3',
            devDependencies: {
              void: '^0.0.1',
              // `vite` keeps `isScaffoldableEmptyProject` from taking
              // the Pages starter branch so we fall through to the
              // demo prompt.
              vite: '^8.0.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      // Yarn Berry lockfile exists but `.pnp.cjs` does NOT yet —
      // `yarn install` creates it below.
      writeFileSync(join(root, 'yarn.lock'), '# yarn lockfile v1\n');
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      // Normalize NODE_OPTIONS so assertions aren't contaminated by
      // the ambient vitest environment.
      const savedNodeOptions = process.env.NODE_OPTIONS;
      delete process.env.NODE_OPTIONS;

      // Simulate `yarn install` writing `.pnp.cjs` AND the post-install
      // marker `.yarn/install-state.gz` as its side effect. Round 40:
      // `isVoidResolvableFrom` now requires BOTH — a committed-but-
      // unfetched `.pnp.cjs` on a fresh clone is no longer proof that
      // `yarn install` has actually populated the archives.
      mockSpawnSync.mockImplementation((command, args, options) => {
        if (
          command === 'yarn' &&
          Array.isArray(args) &&
          args[0] === 'install' &&
          options &&
          typeof options === 'object' &&
          'cwd' in options &&
          typeof options.cwd === 'string'
        ) {
          writeFileSync(join(options.cwd, '.pnp.cjs'), '// pnp stub\n');
          mkdirSync(join(options.cwd, '.yarn'), { recursive: true });
          writeFileSync(join(options.cwd, '.yarn', 'install-state.gz'), '');
        }
        if (
          command === process.execPath &&
          Array.isArray(args) &&
          args[1] === 'generate' &&
          options &&
          typeof options === 'object' &&
          'cwd' in options &&
          typeof options.cwd === 'string'
        ) {
          writeMockGeneratedMigration(options.cwd);
        }
        return { status: 0, stdout: '', stderr: '' };
      });

      try {
        await runInitCommand(root);
      } finally {
        if (savedNodeOptions === undefined) {
          delete process.env.NODE_OPTIONS;
        } else {
          process.env.NODE_OPTIONS = savedNodeOptions;
        }
      }

      // Scaffolded files landed: the schema file is written by
      // `scaffoldDemo` regardless of the PnP detection.
      expect(existsSync(join(root, 'db', 'schema.ts'))).toBe(true);

      // Install WAS invoked — the demo flow still needs to run
      // `yarn install` to pick up the newly-added `void` dep.
      const installCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][0] === 'install',
      );
      expect(installCalls.length).toBeGreaterThan(0);
      expect(installCalls[0][0]).toBe('yarn');

      // The install mock wrote `.pnp.cjs` — verify the post-install
      // marker is present on disk.
      expect(existsSync(join(root, '.pnp.cjs'))).toBe(true);

      // `generateStarterMigration` MUST have spawned drizzle-kit with
      // NODE_OPTIONS containing `--require <pnp-cjs-path>` so the
      // child can resolve `void/schema-d1` through PnP.
      const drizzleCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][1] === 'generate',
      );
      expect(drizzleCalls.length).toBeGreaterThan(0);
      const spawnOptions = drizzleCalls[0][2] as { env?: NodeJS.ProcessEnv };
      expect(spawnOptions.env).toBeDefined();
      expect(typeof spawnOptions.env!.NODE_OPTIONS).toBe('string');
      expect(spawnOptions.env!.NODE_OPTIONS).toContain('--require');
      expect(spawnOptions.env!.NODE_OPTIONS).toContain(JSON.stringify(join(root, '.pnp.cjs')));

      // The round 32 "Yarn PnP" skip note MUST NOT have been emitted —
      // we run the migration inline now.
      const noteCalls = mockNote.mock.calls;
      const matching = noteCalls.filter((call) => call[1] === 'Yarn PnP');
      expect(matching).toHaveLength(0);

      // And the starter migration file was actually written by the
      // mock — sanity check the full flow reached migration scaffold.
      expect(existsSync(join(root, 'db', 'migrations', '0000_generated.sql'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs starter migration in a Yarn 4 project with `.yarnrc.yml` but `nodeLinker: node-modules`', async () => {
    // Round 32 regression: Yarn 3/4 projects configured with
    // `nodeLinker: node-modules` commit `.yarnrc.yml` and still produce
    // a normal `node_modules` tree. Those projects work fine with
    // `generateStarterMigration()` because drizzle-kit can resolve
    // `void/schema-d1` through standard Node module resolution.
    //
    // Round 31 incorrectly treated `.yarnrc.yml` alone as a PnP marker
    // and skipped the migration step for these projects. The fix is to
    // drop `.yarnrc.yml` from the detection and only look at the real
    // post-install markers `.pnp.cjs` / `.pnp.loader.mjs`, which exist
    // iff PnP was the actual linker.
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'yarn-node-modules-app',
            private: true,
            type: 'module',
            packageManager: 'yarn@4.5.3',
            devDependencies: {
              void: '^0.0.1',
              vite: '^8.0.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      // Yarn 4 with nodeLinker: node-modules — `.yarnrc.yml` is
      // committed but there is NO `.pnp.cjs` because PnP is not the
      // active linker. `yarn install` would populate `node_modules`
      // instead.
      writeFileSync(join(root, 'yarn.lock'), '# yarn lockfile v1\n');
      writeFileSync(join(root, '.yarnrc.yml'), 'nodeLinker: node-modules\n');
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      // Simulate `yarn install` populating `node_modules/void` — no
      // `.pnp.cjs` is written because PnP is not active.
      mockSpawnSync.mockImplementation((command, args, options) => {
        if (
          command === 'yarn' &&
          Array.isArray(args) &&
          args[0] === 'install' &&
          options &&
          typeof options === 'object' &&
          'cwd' in options &&
          typeof options.cwd === 'string'
        ) {
          mkdirSync(join(options.cwd, 'node_modules', 'void'), { recursive: true });
          writeFileSync(
            join(options.cwd, 'node_modules', 'void', 'package.json'),
            JSON.stringify({ name: 'void', version: '0.0.1' }, null, 2) + '\n',
          );
        }
        if (
          command === process.execPath &&
          Array.isArray(args) &&
          args[1] === 'generate' &&
          options &&
          typeof options === 'object' &&
          'cwd' in options &&
          typeof options.cwd === 'string'
        ) {
          writeMockGeneratedMigration(options.cwd);
        }
        return { status: 0, stdout: '', stderr: '' };
      });

      await runInitCommand(root);

      // Install ran (needed to populate node_modules for drizzle-kit).
      const installCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][0] === 'install',
      );
      expect(installCalls.length).toBeGreaterThan(0);
      expect(installCalls[0][0]).toBe('yarn');

      // `.pnp.cjs` MUST NOT have been created — PnP is not the linker.
      expect(existsSync(join(root, '.pnp.cjs'))).toBe(false);

      // drizzle-kit generate MUST have been invoked — node-modules
      // linker produces a resolvable `void/schema-d1`.
      const drizzleCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][1] === 'generate',
      );
      expect(drizzleCalls.length).toBeGreaterThan(0);

      // The "Yarn PnP" note MUST NOT have been emitted — this is not a
      // PnP project.
      const noteCalls = mockNote.mock.calls;
      const matching = noteCalls.filter((call) => call[1] === 'Yarn PnP');
      expect(matching).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs starter migration in a Yarn Classic project (yarn.lock + node_modules)', async () => {
    // Round 32: Yarn Classic (`yarn@1.22.x`) always uses the
    // node-modules linker and never writes `.pnp.cjs`. Those projects
    // must run `generateStarterMigration()` normally — the
    // post-install check finds no PnP marker and falls through to the
    // migration branch.
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'yarn-classic-app',
            private: true,
            type: 'module',
            packageManager: 'yarn@1.22.22',
            devDependencies: {
              void: '^0.0.1',
              vite: '^8.0.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(join(root, 'yarn.lock'), '# yarn lockfile v1\n');
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      mockSpawnSync.mockImplementation((command, args, options) => {
        if (
          command === 'yarn' &&
          Array.isArray(args) &&
          args[0] === 'install' &&
          options &&
          typeof options === 'object' &&
          'cwd' in options &&
          typeof options.cwd === 'string'
        ) {
          mkdirSync(join(options.cwd, 'node_modules', 'void'), { recursive: true });
          writeFileSync(
            join(options.cwd, 'node_modules', 'void', 'package.json'),
            JSON.stringify({ name: 'void', version: '0.0.1' }, null, 2) + '\n',
          );
        }
        if (
          command === process.execPath &&
          Array.isArray(args) &&
          args[1] === 'generate' &&
          options &&
          typeof options === 'object' &&
          'cwd' in options &&
          typeof options.cwd === 'string'
        ) {
          writeMockGeneratedMigration(options.cwd);
        }
        return { status: 0, stdout: '', stderr: '' };
      });

      await runInitCommand(root);

      const installCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][0] === 'install',
      );
      expect(installCalls.length).toBeGreaterThan(0);
      expect(installCalls[0][0]).toBe('yarn');

      expect(existsSync(join(root, '.pnp.cjs'))).toBe(false);

      // Yarn Classic is a node-modules linker — drizzle-kit generate
      // must run.
      const drizzleCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][1] === 'generate',
      );
      expect(drizzleCalls.length).toBeGreaterThan(0);

      const noteCalls = mockNote.mock.calls;
      const matching = noteCalls.filter((call) => call[1] === 'Yarn PnP');
      expect(matching).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips starter migration in a workspace subpackage declared via inline `packages: [...]`', async () => {
    // Regression for void-sdk/void#6: a valid `pnpm-workspace.yaml`
    // can declare the packages list inline as
    //   packages: ['packages/*']
    // instead of the multiline block form. The old
    // `extractPnpmWorkspacePackages` only recognized the block form,
    // so inline manifests returned [] from `readWorkspacePatterns`,
    // `isWorkspaceSubpackage` returned false, and `void init` fell
    // through to the fresh-clone install path — which aborts on the
    // subpackage's `workspace:*` spec. The fix adds inline-form
    // support so the subpackage-skip branch fires for both shapes.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages: ['packages/*']\n");

      const subpkgRoot = join(wsroot, 'packages', 'my-app');
      mkdirSync(subpkgRoot, { recursive: true });
      writeFileSync(
        join(subpkgRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'inline-workspace-sub',
            private: true,
            type: 'module',
            devDependencies: {
              void: 'workspace:*',
              vite: '^8.0.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      // Install MUST NOT have run — the inline form is now
      // recognized as declaring the subpackage, so the workspace-
      // subpackage skip branch fires.
      const installCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][0] === 'install',
      );
      expect(installCalls).toHaveLength(0);

      // drizzle-kit was not invoked — starter migration is skipped
      // along with the install for workspace subpackages.
      const drizzleCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][1] === 'generate',
      );
      expect(drizzleCalls).toHaveLength(0);

      // The "Workspace subpackage" note was emitted (so the user
      // knows to run the workspace install).
      const noteCalls = mockNote.mock.calls;
      const matching = noteCalls.filter((call) => call[1] === 'Workspace subpackage');
      expect(matching.length).toBeGreaterThan(0);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('skips starter migration in a workspace subpackage using a leading `./` glob', async () => {
    // Round 31: a real-world `pnpm-workspace.yaml` sometimes writes
    // `- './packages/*'` instead of `- 'packages/*'`. The old
    // segment matcher split on `/` without stripping the leading
    // `./`, so the pattern became `['.', 'packages', '*']` and no
    // subpackage path ever matched — `isWorkspaceSubpackage`
    // returned false and the fresh-clone install branch ran,
    // aborting on the subpackage's `workspace:*` spec. After the
    // normalization fix, leading `./` is stripped before segment
    // splitting and the subpackage-skip branch fires correctly.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - './packages/*'\n");

      const subpkgRoot = join(wsroot, 'packages', 'app');
      mkdirSync(subpkgRoot, { recursive: true });
      writeFileSync(
        join(subpkgRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'dot-slash-sub',
            private: true,
            type: 'module',
            devDependencies: {
              void: 'workspace:*',
              vite: '^8.0.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      const installCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][0] === 'install',
      );
      expect(installCalls).toHaveLength(0);

      const drizzleCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][1] === 'generate',
      );
      expect(drizzleCalls).toHaveLength(0);

      const noteCalls = mockNote.mock.calls;
      const matching = noteCalls.filter((call) => call[1] === 'Workspace subpackage');
      expect(matching.length).toBeGreaterThan(0);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('skips starter migration in a workspace subpackage whose pattern uses a partial glob', async () => {
    // Round 31: real workspaces sometimes declare partial-segment
    // globs like `packages/*-app`, `packages/app-*`, or
    // `apps/*-service`. The old matcher only treated `*` and `**`
    // as whole-segment tokens and rejected any segment that wasn't
    // exactly one of those, so partial globs never matched and
    // fresh workspace subpackages fell through to the install
    // branch. The compiled regex segment handles this correctly.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*-app'\n");

      const subpkgRoot = join(wsroot, 'packages', 'my-app');
      mkdirSync(subpkgRoot, { recursive: true });
      writeFileSync(
        join(subpkgRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'partial-glob-sub',
            private: true,
            type: 'module',
            devDependencies: {
              void: 'workspace:*',
              vite: '^8.0.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      const installCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][0] === 'install',
      );
      expect(installCalls).toHaveLength(0);

      const drizzleCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][1] === 'generate',
      );
      expect(drizzleCalls).toHaveLength(0);

      const noteCalls = mockNote.mock.calls;
      const matching = noteCalls.filter((call) => call[1] === 'Workspace subpackage');
      expect(matching.length).toBeGreaterThan(0);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('runs install for a non-matching subpackage when the workspace uses a partial glob', async () => {
    // Round 31 negative: a workspace that declares `packages/*-app`
    // must NOT treat `packages/other` as a member. The partial-glob
    // matcher is an anchored regex (`^.*-app$`), so `other` must
    // fall through to the fresh-clone install branch.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*-app'\n");

      const subpkgRoot = join(wsroot, 'packages', 'other');
      mkdirSync(subpkgRoot, { recursive: true });
      writeFileSync(
        join(subpkgRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'non-matching-sub',
            private: true,
            type: 'module',
            devDependencies: {
              void: '^0.0.1',
              vite: '^8.0.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(join(subpkgRoot, 'package-lock.json'), '{}\n');
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      // Install MUST have run — `packages/other` does not match
      // `packages/*-app`.
      const installCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][0] === 'install',
      );
      expect(installCalls.length).toBeGreaterThan(0);

      // drizzle-kit generate was invoked — the initial migration
      // scaffolded via `generateStarterMigration`.
      const drizzleCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][1] === 'generate',
      );
      expect(drizzleCalls.length).toBeGreaterThan(0);

      // The "Workspace subpackage" note MUST NOT have been emitted.
      const noteCalls = mockNote.mock.calls;
      const matching = noteCalls.filter((call) => call[1] === 'Workspace subpackage');
      expect(matching).toHaveLength(0);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('skips starter migration in a workspace subpackage whose pattern uses brace expansion', async () => {
    // Regression for the P2 Codex finding: real `pnpm-workspace.yaml`
    // files frequently use `{apps,packages}/*` and similar brace
    // expansions. The old segment matcher passed `{apps,packages}`
    // through as a literal (braces hit the regex-escape path) and no
    // subpackage path ever matched — `isWorkspaceSubpackage`
    // returned false and `void init` fell into the fresh-clone
    // install branch, which aborts on the subpackage's `workspace:*`
    // spec. With the brace-expansion fix, `{apps,packages}/*` is
    // expanded into `['apps/*', 'packages/*']` BEFORE matching, so
    // the subpackage-skip branch fires correctly.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - '{apps,packages}/*'\n");

      const subpkgRoot = join(wsroot, 'packages', 'my-app');
      mkdirSync(subpkgRoot, { recursive: true });
      writeFileSync(
        join(subpkgRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'brace-glob-sub',
            private: true,
            type: 'module',
            devDependencies: {
              void: 'workspace:*',
              vite: '^8.0.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      const installCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][0] === 'install',
      );
      expect(installCalls).toHaveLength(0);

      const drizzleCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][1] === 'generate',
      );
      expect(drizzleCalls).toHaveLength(0);

      const noteCalls = mockNote.mock.calls;
      const matching = noteCalls.filter((call) => call[1] === 'Workspace subpackage');
      expect(matching.length).toBeGreaterThan(0);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('skips starter migration in a workspace subpackage using brace expansion under `apps/`', async () => {
    // Same fix as the previous test, but exercises the other branch
    // of the brace expansion: the subpackage lives under `apps/`, not
    // `packages/`. Both expansions of `{apps,packages}/*` must match
    // so neither subpackage path falls through to the fresh-clone
    // install branch.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - '{apps,packages}/*'\n");

      const subpkgRoot = join(wsroot, 'apps', 'my-app');
      mkdirSync(subpkgRoot, { recursive: true });
      writeFileSync(
        join(subpkgRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'brace-glob-apps',
            private: true,
            type: 'module',
            devDependencies: {
              void: 'workspace:*',
              vite: '^8.0.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      const installCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][0] === 'install',
      );
      expect(installCalls).toHaveLength(0);

      const noteCalls = mockNote.mock.calls;
      const matching = noteCalls.filter((call) => call[1] === 'Workspace subpackage');
      expect(matching.length).toBeGreaterThan(0);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('runs install for a non-matching subpackage when the workspace uses brace expansion', async () => {
    // Brace expansion is a positive-match operation, not a catch-all.
    // `{apps,packages}/*` must NOT match `other/my-app` — neither
    // expansion (`apps/*` nor `packages/*`) lines up with `other/`,
    // so the subpackage correctly falls through to the fresh-clone
    // install branch.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - '{apps,packages}/*'\n");

      const subpkgRoot = join(wsroot, 'other', 'my-app');
      mkdirSync(subpkgRoot, { recursive: true });
      writeFileSync(
        join(subpkgRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'non-matching-brace',
            private: true,
            type: 'module',
            devDependencies: {
              void: '^0.0.1',
              vite: '^8.0.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(join(subpkgRoot, 'package-lock.json'), '{}\n');
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      // Install must have run — `other/my-app` does not match
      // `{apps,packages}/*`.
      const installCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][0] === 'install',
      );
      expect(installCalls.length).toBeGreaterThan(0);

      const noteCalls = mockNote.mock.calls;
      const matching = noteCalls.filter((call) => call[1] === 'Workspace subpackage');
      expect(matching).toHaveLength(0);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('skips starter migration in a workspace subpackage whose `package.json#workspaces` uses brace expansion', async () => {
    // Brace expansion also has to work when the workspace is declared
    // via `package.json#workspaces` (the npm/yarn convention) rather
    // than `pnpm-workspace.yaml`. Same pattern, same fix — the glob
    // expansion happens before segment matching either way.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(wsroot, 'package.json'),
        JSON.stringify(
          {
            name: 'brace-ws-root',
            private: true,
            workspaces: ['{apps,packages}/*'],
          },
          null,
          2,
        ) + '\n',
      );
      // An npm lockfile at the workspace root — this establishes the
      // ancestor workspace marker without touching pnpm-workspace.yaml.
      writeFileSync(join(wsroot, 'package-lock.json'), '{}\n');

      const subpkgRoot = join(wsroot, 'apps', 'web');
      mkdirSync(subpkgRoot, { recursive: true });
      writeFileSync(
        join(subpkgRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'brace-npm-ws-sub',
            private: true,
            type: 'module',
            devDependencies: {
              void: 'workspace:*',
              vite: '^8.0.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      const installCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][0] === 'install',
      );
      expect(installCalls).toHaveLength(0);

      const noteCalls = mockNote.mock.calls;
      const matching = noteCalls.filter((call) => call[1] === 'Workspace subpackage');
      expect(matching.length).toBeGreaterThan(0);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('void init in an empty pnpm workspace subpackage skips leaf install and starter migration', async () => {
    // Round 41 regression for void-sdk/void#6: the empty-project Pages
    // starter branch (`isScaffoldableEmptyProject(root)` → `scaffoldPagesApp`)
    // had no workspace-subpackage detection. It unconditionally set
    // `scaffoldAddedDependencies = true` and the trailing gate then
    // invoked `installProjectDependencies` with the fallback `npm`
    // package manager inside a pnpm workspace subpackage — which either
    // writes a stray `node_modules/` / `package-lock.json` that fights
    // the workspace manager's hoisting, or aborts outright on the
    // template's `workspace:` specs. It also ran
    // `generateStarterMigration`, which fails identically because
    // drizzle-kit can't resolve `void/schema-d1` from an un-installed
    // subpackage. Mirror the demo branch's round-29 skip.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      // Workspace root: pnpm-workspace.yaml declaring `packages/*`.
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

      // Subpackage: truly empty directory — no `package.json`, no files.
      // `isScaffoldableEmptyProject` returns true and
      // `runInitCommand` takes the Pages starter branch.
      const subpkgRoot = join(wsroot, 'packages', 'my-new-app');
      mkdirSync(subpkgRoot, { recursive: true });

      // Framework prompt → vue, starter mode → sqlite, agent prompt → generic.
      mockSelect
        .mockResolvedValueOnce('vue')
        .mockResolvedValueOnce('sqlite')
        .mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      // `scaffoldPagesApp` still ran: the template files and a fresh
      // `package.json` landed in the subpackage.
      const pkg = JSON.parse(readFileSync(join(subpkgRoot, 'package.json'), 'utf-8'));
      expect(pkg.devDependencies.void).toBeDefined();
      expect(pkg.devDependencies['@void/vue']).toBeDefined();

      // Install MUST NOT be invoked — running `npm install` here would
      // either pollute the workspace or abort on `workspace:` specs.
      const installCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][0] === 'install',
      );
      expect(installCalls).toHaveLength(0);

      // `generateStarterMigration` MUST NOT spawn drizzle-kit — the
      // subpackage has no `node_modules` yet to resolve `void/schema-d1`
      // through.
      const drizzleCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][1] === 'generate',
      );
      expect(drizzleCalls).toHaveLength(0);

      // The user-facing `note()` was emitted with "Workspace subpackage"
      // and points the user at the workspace root.
      const noteCalls = mockNote.mock.calls;
      const matching = noteCalls.filter((call) => call[1] === 'Workspace subpackage');
      expect(matching.length).toBeGreaterThan(0);
      const body = String(matching[0][0]);
      expect(body).toMatch(/Scaffolded the Pages starter/);
      expect(body).toMatch(/void db generate/);
      expect(body).toContain(wsroot);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  // Note on codex review "Issue #1 (BLOCKER)": the original codex pass
  // claimed the starter-path gate could fall through to
  // `generateStarterMigration` for a workspace subpackage that
  // pre-declared `void + adapter`, because `scaffoldPagesApp`'s
  // `dependencyAdded` would stay false. That is unreachable in practice:
  // `isScaffoldableEmptyProject` only allows `void`/`@void-sdk/void` +
  // the adapter packages in declared deps (see
  // `EMPTY_PROJECT_ALLOWED_PACKAGES`), but the Vue+sqlite template at
  // `template.ts:169..177` pulls in `hono`, `vue`, `vite`, and
  // `typescript` — none of which the allowlist permits. So whenever
  // `runInitCommand` reaches the starter branch, `scaffoldPagesApp`'s
  // `ensureDependency` is guaranteed to flip `dependencyAdded` to true,
  // and the old `scaffoldWroteDeps && isMember` gate fired correctly.
  //
  // The starter-branch refactor still happened (it now goes through
  // `resolveWorkspaceDeferral + isVoidResolvableFrom`) for a different
  // reason — consistency with the demo branch and the new
  // local-lockfile veto behavior. That code path is exercised by the
  // "honors a local `package-lock.json` veto" test below (issue #2
  // regression) which depends on `resolveWorkspaceDeferral` flowing
  // through the starter branch.

  it('omits the `void db generate` follow-up in the workspace skip note AND outro for static starter mode (codex review)', async () => {
    // Regression for the codex follow-up review: the workspace-subpackage
    // note and outro previously always told the user to run
    // `void db generate`, but `template.ts:156` only emits a `db/schema.ts`
    // when `starterMode !== 'static'`. Static starter projects have no
    // schema file, so the migration follow-up is meaningless and confusing.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

      const subpkgRoot = join(wsroot, 'packages', 'static-starter');
      mkdirSync(subpkgRoot, { recursive: true });

      mockSelect
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('static')
        .mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      const noteCalls = mockNote.mock.calls;
      const matching = noteCalls.filter((call) => call[1] === 'Workspace subpackage');
      expect(matching.length).toBeGreaterThan(0);
      const body = String(matching[0][0]);
      // Static mode → no migration scaffold → no `void db generate`
      // follow-up in the note.
      expect(body).not.toMatch(/void db generate/);
      // The install half of the message is still required.
      expect(body).toMatch(/Run your workspace install/);

      // The outro must also drop the migration follow-up for static.
      const outroCalls = mockOutro.mock.calls;
      expect(outroCalls.length).toBeGreaterThan(0);
      const outroText = String(outroCalls[outroCalls.length - 1][0]);
      expect(outroText).not.toMatch(/void db generate/);
      expect(outroText).toMatch(/Run your workspace install/);

      // Sanity: no migration was generated (drizzle-kit was never spawned).
      const drizzleCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][1] === 'generate',
      );
      expect(drizzleCalls).toHaveLength(0);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('skips GitHub Actions setup for `void init --github` in a workspace subpackage (codex review pass 2)', async () => {
    // Regression for codex review pass 2: the original Issue 3 fix
    // gated `setupGithubActions` on `workspaceSubpackageSkip`, but that
    // flag is only ever set inside the interactive `!targeted` scaffold
    // branches. A targeted `void init --github` invocation in a
    // workspace subpackage therefore reached Step 8 with
    // `workspaceSubpackageSkip === false` and still wrote
    // `.github/workflows/deploy.yml` under the subpackage root — the
    // file GitHub will not read.
    //
    // The fix detects workspace-subpackage membership directly in Step 8
    // via `isInsideWorkspaceSubpackage(root)` so the skip applies
    // independently of the interactive flag AND independently of
    // whether the subpackage manages its own install.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

      const subpkgRoot = join(wsroot, 'packages', 'targeted-gha');
      mkdirSync(subpkgRoot, { recursive: true });
      writeFileSync(
        join(subpkgRoot, 'package.json'),
        JSON.stringify({ name: 'targeted-gha-sub', private: true, type: 'module' }, null, 2) + '\n',
      );

      // Targeted `void init --github` — no scaffolding, no prompts.
      await runInitCommand(subpkgRoot, { github: true, tsconfig: false, agents: false });

      // The deploy.yml MUST NOT have been written under the subpackage.
      const deployYmlPath = join(subpkgRoot, '.github', 'workflows', 'deploy.yml');
      expect(existsSync(deployYmlPath)).toBe(false);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('skips GitHub Actions setup for `void init --github` in a leaf-managed workspace subpackage (codex review pass 3)', async () => {
    // Regression for codex review pass 3: the pass-2 fix used
    // `resolveWorkspaceDeferral()` to decide the Step 8 skip, but that
    // helper intentionally returns `undefined` for leaf-managed
    // subpackages (local lockfile or a non-pnpm Corepack pin) because
    // the leaf owns its install. That's the RIGHT call for install/migration
    // deferral, but the WRONG call for `.github/workflows/*` — GitHub
    // only reads workflow files from the repository root regardless of
    // whether a nested package self-manages its install. A leaf-managed
    // subpackage is still structurally a workspace member, and dropping
    // `.github/workflows/deploy.yml` under it still yields a file GitHub
    // will silently ignore.
    //
    // The pass-3 fix switches Step 8 to `isInsideWorkspaceSubpackage`,
    // which only checks structural membership. Cover both leaf-managed
    // arms (local lockfile AND local non-pnpm Corepack pin).
    for (const shape of ['local-lockfile', 'local-corepack-pin'] as const) {
      const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
      try {
        writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

        const subpkgRoot = join(wsroot, 'packages', `leaf-${shape}`);
        mkdirSync(subpkgRoot, { recursive: true });
        const pkgBody: Record<string, unknown> = {
          name: `leaf-${shape}-sub`,
          private: true,
          type: 'module',
        };
        if (shape === 'local-corepack-pin') {
          pkgBody.packageManager = 'bun@1.1.42';
        }
        writeFileSync(join(subpkgRoot, 'package.json'), JSON.stringify(pkgBody, null, 2) + '\n');
        if (shape === 'local-lockfile') {
          writeFileSync(join(subpkgRoot, 'bun.lock'), '');
        }

        await runInitCommand(subpkgRoot, { github: true, tsconfig: false, agents: false });

        const deployYmlPath = join(subpkgRoot, '.github', 'workflows', 'deploy.yml');
        expect(existsSync(deployYmlPath)).toBe(false);
      } finally {
        rmSync(wsroot, { recursive: true, force: true });
      }
    }
  });

  it('runs install (does NOT take the workspace skip path) for a starter init when the subpackage has a local `packageManager: bun@…` Corepack pin (codex review pass 2)', async () => {
    // Regression for codex review pass 2: `resolveWorkspaceDeferral`
    // honors a local non-pnpm `packageManager` Corepack pin as a
    // self-management signal — but the only end-to-end test that
    // exercised that arm went through `ensureVoidDependency`, NOT
    // through `runInitCommand`'s starter branch. This test covers the
    // starter flow.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

      const subpkgRoot = join(wsroot, 'packages', 'leaf-bun');
      mkdirSync(subpkgRoot, { recursive: true });
      // No local lockfile, but a local Corepack pin → self-managed.
      writeFileSync(
        join(subpkgRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'leaf-bun-sub',
            private: true,
            type: 'module',
            packageManager: 'bun@1.1.42',
          },
          null,
          2,
        ) + '\n',
      );

      mockSelect
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('sqlite')
        .mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      // Install MUST run — the leaf is self-managed via the local
      // Corepack pin, not deferred to the workspace. Assert it ran
      // through `bun`, not some other manager, which proves the local
      // Corepack pin was actually honored (codex review pass 3 nit).
      const installCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][0] === 'install',
      );
      expect(installCalls.length).toBeGreaterThan(0);
      expect(installCalls[0][0]).toBe('bun');

      // No "Workspace subpackage" note — we did not defer.
      const noteCalls = mockNote.mock.calls;
      const matching = noteCalls.filter((call) => call[1] === 'Workspace subpackage');
      expect(matching).toHaveLength(0);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('honors a local `package-lock.json` veto for a yarn-leaf nested under a pnpm workspace (codex review issue #2)', async () => {
    // Regression for codex review issue #2: `isPnpmProject` had a local
    // lockfile veto so a leaf-managed subpackage with its own
    // `package-lock.json` correctly returned non-pnpm — but the
    // workspace-skip path used `isWorkspaceSubpackage` directly with no
    // such veto, so the same directory got the workspace-skip treatment
    // (no install) even though `isPnpmProject` already deemed it
    // self-managed. The two helpers must agree, otherwise we get
    // mismatched behavior on the same root.
    //
    // `resolveWorkspaceDeferral` honors local lockfiles — a
    // `package-lock.json` inside the subpackage means "I manage my own
    // install", so the workspace skip MUST NOT fire and the normal
    // standalone install path must run.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

      const subpkgRoot = join(wsroot, 'packages', 'leaf-managed');
      mkdirSync(subpkgRoot, { recursive: true });
      // Local `package-lock.json` claims leaf management.
      writeFileSync(join(subpkgRoot, 'package-lock.json'), '{}\n');

      mockSelect
        .mockResolvedValueOnce('vue')
        .mockResolvedValueOnce('sqlite')
        .mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      // Install MUST run — the leaf is self-managed via its own
      // `package-lock.json`, not deferred to the workspace.
      const installCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][0] === 'install',
      );
      expect(installCalls.length).toBeGreaterThan(0);

      // The "Workspace subpackage" note MUST NOT fire — we're not
      // deferring to the workspace.
      const noteCalls = mockNote.mock.calls;
      const matching = noteCalls.filter((call) => call[1] === 'Workspace subpackage');
      expect(matching).toHaveLength(0);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('skips GitHub Actions setup when the workspace-subpackage skip path fires (codex review issue #3)', async () => {
    // Regression for codex review issue #3: when the workspace-subpackage
    // skip path fires, `setupGithubActions()` would still write
    // `.github/workflows/deploy.yml` UNDER the subpackage root, but
    // GitHub only reads `.github/workflows/*` from the repository root
    // — so the workflow file is silently ignored. The right behavior
    // is to skip the GitHub Actions setup entirely in skip mode and
    // surface a note pointing the user back to the repo root.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

      const subpkgRoot = join(wsroot, 'packages', 'gha-skip');
      mkdirSync(subpkgRoot, { recursive: true });

      mockSelect
        .mockResolvedValueOnce('vue')
        .mockResolvedValueOnce('sqlite')
        .mockResolvedValueOnce('generic');
      // Demo prompt → no, GitHub Actions prompt → yes (the user opts in
      // but the skip path must override it because the workflow file
      // would land in the wrong place).
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

      await runInitCommand(subpkgRoot);

      // No `.github/workflows/deploy.yml` was written under the
      // subpackage — that file would never be read by GitHub.
      const deployYmlPath = join(subpkgRoot, '.github', 'workflows', 'deploy.yml');
      expect(existsSync(deployYmlPath)).toBe(false);

      // The workspace skip note still fired.
      const noteCalls = mockNote.mock.calls;
      const matching = noteCalls.filter((call) => call[1] === 'Workspace subpackage');
      expect(matching.length).toBeGreaterThan(0);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('void init in an empty STANDALONE app (not a workspace subpackage) still runs install and starter migration', async () => {
    // Symmetric proof that the round-41 workspace-subpackage skip ONLY
    // fires when `root` is a declared member of an ancestor workspace.
    // A bare `my-app/` under a parent dir with no `pnpm-workspace.yaml`
    // and no `package.json#workspaces` must still take the normal
    // install + migration path.
    const parent = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      // No workspace marker anywhere.
      const appRoot = join(parent, 'my-app');
      mkdirSync(appRoot, { recursive: true });

      mockSelect
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('sqlite')
        .mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(appRoot);

      // Install WAS invoked — the fallback `npm install` runs against
      // the standalone leaf app.
      const installCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][0] === 'install',
      );
      expect(installCalls.length).toBeGreaterThan(0);

      // `generateStarterMigration` DID spawn drizzle-kit.
      const drizzleCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][1] === 'generate',
      );
      expect(drizzleCalls.length).toBeGreaterThan(0);

      // The "Workspace subpackage" note was NOT emitted — this path is
      // reserved for declared workspace members.
      const noteCalls = mockNote.mock.calls;
      const matching = noteCalls.filter((call) => call[1] === 'Workspace subpackage');
      expect(matching).toHaveLength(0);

      // And the migration actually landed.
      expect(listMigrationSqlFiles(appRoot)).toEqual(['0000_generated.sql']);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  // Round 44 regression: `scaffoldPagesApp` previously only wrote
  // `pnpm.onlyBuiltDependencies` when `packageManager === 'pnpm'`. But
  // for a workspace subpackage with no local lockfile / Corepack pin,
  // `detectProjectState` returns `'npm'` — the pnpm branch never fires
  // and the subpackage's built-deps allowlist is silently dropped,
  // which suppresses better-sqlite3 / esbuild / workerd postinstalls on
  // the next workspace-root `pnpm install`. Gate the allowlist on the
  // ancestor-aware `isPnpmProject` check instead.
  it('writes pnpm.onlyBuiltDependencies for a pnpm workspace subpackage (Round 44)', async () => {
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      // Workspace root: pnpm-workspace.yaml with `packages/*`. The root
      // holds the Corepack pin — NOT the subpackage.
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      writeFileSync(
        join(wsroot, 'package.json'),
        JSON.stringify(
          { name: 'workspace-root', private: true, packageManager: 'pnpm@10.33.0' },
          null,
          2,
        ) + '\n',
      );

      // Subpackage: empty directory, no local lockfile, no local
      // Corepack pin. `detectProjectState` returns `'npm'` here.
      const subpkgRoot = join(wsroot, 'packages', 'my-new-app');
      mkdirSync(subpkgRoot, { recursive: true });

      mockSelect
        .mockResolvedValueOnce('vue')
        .mockResolvedValueOnce('sqlite')
        .mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      const pkg = JSON.parse(readFileSync(join(subpkgRoot, 'package.json'), 'utf-8'));

      // The built-deps allowlist MUST be present — this is the
      // regression target. Mirrors the standalone-pnpm assertion above.
      expect(pkg.pnpm?.onlyBuiltDependencies).toEqual(
        expect.arrayContaining(['better-sqlite3', 'esbuild', 'workerd']),
      );
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('does NOT write a per-package `packageManager` pin in a pnpm workspace subpackage (Round 44)', async () => {
    // The Corepack pin belongs to the workspace root. Duplicating it
    // per-subpackage confuses Corepack and can conflict with the root
    // pin on future upgrades — so the subpackage's `package.json` must
    // be left without a `packageManager` field.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      writeFileSync(
        join(wsroot, 'package.json'),
        JSON.stringify(
          { name: 'workspace-root', private: true, packageManager: 'pnpm@10.33.0' },
          null,
          2,
        ) + '\n',
      );

      const subpkgRoot = join(wsroot, 'packages', 'my-new-app');
      mkdirSync(subpkgRoot, { recursive: true });

      mockSelect
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('sqlite')
        .mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      const pkg = JSON.parse(readFileSync(join(subpkgRoot, 'package.json'), 'utf-8'));
      expect(pkg.packageManager).toBeUndefined();
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('writes BOTH pnpm.onlyBuiltDependencies AND packageManager pin in a standalone pnpm project (Round 44)', async () => {
    // Symmetric proof that the standalone-pnpm path still writes both
    // the allowlist AND the Corepack pin, after the Round 44 split.
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      // Local `pnpm-lock.yaml` → `detectProjectState` picks pnpm.
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");

      mockSelect
        .mockResolvedValueOnce('vue')
        .mockResolvedValueOnce('sqlite')
        .mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(pkg.pnpm?.onlyBuiltDependencies).toEqual(
        expect.arrayContaining(['better-sqlite3', 'esbuild', 'workerd']),
      );
      expect(pkg.packageManager).toBe('pnpm@10.33.0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ensureVoidDependency', () => {
  it('creates package.json with type: "module" when none exists (greenfield)', () => {
    withTempDir((root) => {
      ensureVoidDependency(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(pkg.type).toBe('module');
      expect(pkg.private).toBe(true);
      expect(typeof pkg.devDependencies.void).toBe('string');
    });
  });

  it('leaves existing CommonJS package.json alone (does not add type: "module")', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'legacy-app',
            private: true,
            dependencies: { express: '^4.18.0' },
          },
          null,
          2,
        ) + '\n',
      );

      ensureVoidDependency(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      // Critical assertion: the absent `type` must stay absent so sibling
      // `.js` scripts keep being interpreted as CommonJS.
      expect(pkg.type).toBeUndefined();
      // The helper still ensures `void` is declared as a devDependency.
      expect(typeof pkg.devDependencies.void).toBe('string');
      // Pre-existing fields are preserved.
      expect(pkg.name).toBe('legacy-app');
      expect(pkg.dependencies.express).toBe('^4.18.0');
    });
  });

  it('leaves existing ESM package.json alone (type: "module" stays)', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'esm-app',
            private: true,
            type: 'module',
            dependencies: {},
          },
          null,
          2,
        ) + '\n',
      );

      ensureVoidDependency(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(pkg.type).toBe('module');
      expect(typeof pkg.devDependencies.void).toBe('string');
      expect(pkg.name).toBe('esm-app');
    });
  });

  it('does not clobber an existing void dependency declaration', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'pinned-void-app',
            private: true,
            devDependencies: {
              void: 'npm:@void-sdk/void@^0.2.3',
            },
          },
          null,
          2,
        ) + '\n',
      );

      ensureVoidDependency(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(pkg.devDependencies.void).toBe('npm:@void-sdk/void@^0.2.3');
      expect(pkg.type).toBeUndefined();
    });
  });

  it('does not add private: true to an existing package.json that omits it', () => {
    // An existing package.json that intentionally omits `private` (e.g. a
    // library or app meant to be published to a registry) must stay
    // non-private after `ensureVoidDependency`. Flipping it to `private:
    // true` silently would change publish semantics.
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'publishable-app',
            version: '1.2.3',
            dependencies: { react: '^18.0.0' },
          },
          null,
          2,
        ) + '\n',
      );

      ensureVoidDependency(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      // Critical: `private` must stay absent so publish semantics are
      // preserved.
      expect(pkg.private).toBeUndefined();
      // Pre-existing fields are still preserved and void was added to
      // devDependencies.
      expect(pkg.name).toBe('publishable-app');
      expect(pkg.version).toBe('1.2.3');
      expect(pkg.dependencies.react).toBe('^18.0.0');
      expect(typeof pkg.devDependencies.void).toBe('string');
    });
  });

  it('does not flip private: false to private: true on an existing package.json', () => {
    // An existing package.json with `private: false` (e.g. an explicitly
    // publishable package) must stay that way after `ensureVoidDependency`.
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'explicitly-public',
            private: false,
            dependencies: {},
          },
          null,
          2,
        ) + '\n',
      );

      ensureVoidDependency(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(pkg.private).toBe(false);
      expect(typeof pkg.devDependencies.void).toBe('string');
    });
  });

  it('rewrites a bare `workspace:*` preview spec to the pnpm aliased form (pnpm project)', () => {
    // Regression: when the scaffold target has `@void-sdk/void:
    // "workspace:*"` in devDependencies (no `void` alias yet), the
    // previous `toAliasedPreviewSpec` returned `"workspace:*"` unchanged
    // because its `@void-sdk/<name>` regex found nothing to replace. pnpm
    // then interpreted `"void": "workspace:*"` as a request for a
    // workspace package literally named `void` — which does not exist —
    // and the demo scaffold's install step failed. The fix rewrites the
    // bare spec into pnpm's aliased-workspace form so `void` resolves to
    // the real `@void-sdk/void` workspace package. Gated on
    // `isPnpmProject` since round 26, so this test seeds a pnpm lockfile.
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'workspace-star-app',
            private: true,
            devDependencies: {
              '@void-sdk/void': 'workspace:*',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");

      ensureVoidDependency(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(pkg.devDependencies.void).toBe('workspace:@void-sdk/void@*');
      // The pre-existing preview declaration is untouched.
      expect(pkg.devDependencies['@void-sdk/void']).toBe('workspace:*');
    });
  });

  it('rewrites a bare `workspace:^1.2.3` preview spec to the pnpm aliased form (pnpm project)', () => {
    // Same bug as `workspace:*`, but with a pinned semver range. The bare
    // form `workspace:^1.2.3` contains no `@void-sdk/` substring, so the
    // old regex was a no-op and the result would have been
    // `"void": "workspace:^1.2.3"` — still interpreted by pnpm as a
    // lookup for a workspace package literally named `void`. The bare
    // branch must preserve the range alongside the aliased name. Gated
    // on `isPnpmProject` since round 26.
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'workspace-range-app',
            private: true,
            devDependencies: {
              '@void-sdk/void': 'workspace:^1.2.3',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");

      ensureVoidDependency(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(pkg.devDependencies.void).toBe('workspace:@void-sdk/void@^1.2.3');
      expect(pkg.devDependencies['@void-sdk/void']).toBe('workspace:^1.2.3');
    });
  });

  it('falls back to the portable `npm:<alias>@<version>` form for a bare `workspace:*` on a non-pnpm project', () => {
    // Regression for void-sdk/void#6 round 26: the pnpm aliased-workspace
    // form `workspace:<alias>@<range>` is pnpm-specific. Yarn Berry and
    // Bun workspaces don't understand that syntax — a project with a
    // `@void-sdk/void: "workspace:*"` source spec under npm/yarn/bun would
    // get a `void: "workspace:@void-sdk/void@*"` entry that the subsequent
    // install rejects as invalid. For non-pnpm signals, fall back to the
    // `npm:<alias>@<range>` alias form, which every package manager
    // accepts. The range degenerates to the caller's fallback version
    // (the installed void version) when the source is bare `workspace:*`.
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'workspace-star-non-pnpm-app',
            private: true,
            devDependencies: {
              '@void-sdk/void': 'workspace:*',
            },
          },
          null,
          2,
        ) + '\n',
      );
      // Signal npm via package-lock.json — no pnpm-lock, no packageManager
      // field. `isPnpmProject` returns false.
      writeFileSync(join(root, 'package-lock.json'), '{}\n');

      ensureVoidDependency(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      // Must NOT emit `workspace:@void-sdk/void@*` on a non-pnpm project.
      expect(pkg.devDependencies.void).not.toBe('workspace:@void-sdk/void@*');
      // Must be the portable npm alias form pinned to a concrete
      // version (the caller's fallback — `getOwnVersion()` at runtime).
      expect(pkg.devDependencies.void).toMatch(/^npm:@void-sdk\/void@[^*]/);
      // The pre-existing preview declaration stays untouched.
      expect(pkg.devDependencies['@void-sdk/void']).toBe('workspace:*');
    });
  });

  it('leaves a `workspace:../path` preview spec unchanged', () => {
    // Path-form workspace specs (e.g. `workspace:../packages/void`)
    // resolve to a workspace package at that relative path — pnpm picks
    // the package by location, not by name. The previous bare-workspace
    // branch wrapped the path in pnpm's aliased form, producing
    // `workspace:@void-sdk/void@../packages/void`, which pnpm rejects.
    // Path specs must pass through to the aliased `void` entry untouched.
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'workspace-parent-path-app',
            private: true,
            devDependencies: {
              '@void-sdk/void': 'workspace:../packages/void',
            },
          },
          null,
          2,
        ) + '\n',
      );

      ensureVoidDependency(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(pkg.devDependencies.void).toBe('workspace:../packages/void');
      expect(pkg.devDependencies['@void-sdk/void']).toBe('workspace:../packages/void');
    });
  });

  it('leaves a `workspace:./path` preview spec unchanged', () => {
    // Same path-form rationale as `workspace:../path`, but with the
    // current-directory `./` prefix. Both must pass through unchanged.
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'workspace-current-path-app',
            private: true,
            devDependencies: {
              '@void-sdk/void': 'workspace:./vendor/void',
            },
          },
          null,
          2,
        ) + '\n',
      );

      ensureVoidDependency(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(pkg.devDependencies.void).toBe('workspace:./vendor/void');
      expect(pkg.devDependencies['@void-sdk/void']).toBe('workspace:./vendor/void');
    });
  });

  it('adds the pnpm built-dep allowlist when the project uses pnpm', () => {
    // Regression for void-sdk/void#6 round 19: the demo scaffold path
    // (scaffoldDemo -> ensureVoidDependency) must mirror scaffoldPagesApp's
    // `pnpm.onlyBuiltDependencies` treatment so existing pnpm projects that
    // accept the demo don't break on first local DB / dev commands — pnpm
    // 10 ignores build scripts (better-sqlite3/esbuild/workerd) unless they
    // are explicitly allowlisted.
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'existing-pnpm-app',
            private: true,
            dependencies: {},
          },
          null,
          2,
        ) + '\n',
      );
      // Signal pnpm via lockfile presence — mirrors detectProjectState.
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");

      ensureVoidDependency(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(pkg.pnpm?.onlyBuiltDependencies).toEqual(
        expect.arrayContaining(['better-sqlite3', 'esbuild', 'workerd']),
      );
      // Sanity: the void dep was still added in the same pass.
      expect(typeof pkg.devDependencies.void).toBe('string');
    });
  });

  it('adds the pnpm built-dep allowlist when package.json#packageManager is pnpm with no lockfile', () => {
    // Regression for void-sdk/void#6 round 22: round 21 extended
    // `detectProjectState` to honor `package.json#packageManager` (Corepack
    // pin) when no lockfile is committed yet, so a fresh repo can be "pnpm"
    // without `pnpm-lock.yaml`. `runInitCommand` then runs `pnpm install`
    // against it. The lockfile-only predicate previously gating
    // `ensurePnpmBuiltDependencies` here missed that case, so a freshly
    // scaffolded demo would skip the allowlist and break on first local
    // DB / dev commands. Both pnpm signals must trigger the allowlist.
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'fresh-pnpm-pin',
            private: true,
            packageManager: 'pnpm@10.2.3',
            dependencies: {},
          },
          null,
          2,
        ) + '\n',
      );
      // No pnpm-lock.yaml — Corepack pin is the only pnpm signal.

      ensureVoidDependency(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(pkg.pnpm?.onlyBuiltDependencies).toEqual(
        expect.arrayContaining(['better-sqlite3', 'esbuild', 'workerd']),
      );
      // Sanity: the void dep was still added in the same pass.
      expect(typeof pkg.devDependencies.void).toBe('string');
      // Sanity: the Corepack pin was preserved verbatim.
      expect(pkg.packageManager).toBe('pnpm@10.2.3');
    });
  });

  it('returns false and leaves package.json untouched when void is already declared and project is not pnpm', () => {
    // Regression for void-sdk/void#6 round 24: workspace subpackages that
    // already declare `void` as a `workspace:` spec but have no local
    // lockfile or `package.json#packageManager` pin. `detectProjectState`
    // falls back to `npm`, and the previous demo path unconditionally
    // forced a post-demo `npm install` which aborts immediately on
    // `workspace:` ranges. The fix is for `ensureVoidDependency` to
    // surface a `changed` signal so the demo path only installs when it
    // actually mutated `package.json`.
    withTempDir((root) => {
      const pkgJson =
        JSON.stringify(
          {
            name: 'existing-subpackage',
            private: true,
            type: 'module',
            devDependencies: {
              void: 'workspace:../packages/void',
            },
          },
          null,
          2,
        ) + '\n';
      writeFileSync(join(root, 'package.json'), pkgJson);
      // No pnpm-lock.yaml, no packageManager field — so
      // `detectProjectState` would fall back to `npm` and
      // `isPnpmProject` returns false.

      const changed = ensureVoidDependency(root);

      expect(changed).toBe(false);
      // package.json must be byte-for-byte unchanged — no spurious write.
      expect(readFileSync(join(root, 'package.json'), 'utf-8')).toBe(pkgJson);
    });
  });

  it('returns true when the void dep is newly added', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'no-void-yet',
            private: true,
            type: 'module',
            dependencies: {},
          },
          null,
          2,
        ) + '\n',
      );

      const changed = ensureVoidDependency(root);

      expect(changed).toBe(true);
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(typeof pkg.devDependencies.void).toBe('string');
    });
  });

  it('returns true when only the pnpm built-dep allowlist is added (void already declared)', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'existing-pnpm-with-void',
            private: true,
            type: 'module',
            devDependencies: {
              void: 'workspace:../packages/void',
            },
          },
          null,
          2,
        ) + '\n',
      );
      // Signal pnpm via lockfile presence — mirrors detectProjectState.
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");

      const changed = ensureVoidDependency(root);

      expect(changed).toBe(true);
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      // The allowlist must have been written.
      expect(pkg.pnpm?.onlyBuiltDependencies).toEqual(
        expect.arrayContaining(['better-sqlite3', 'esbuild', 'workerd']),
      );
      // The pre-existing void spec must be preserved verbatim.
      expect(pkg.devDependencies.void).toBe('workspace:../packages/void');
    });
  });

  it('emits the pnpm aliased-workspace form in a pnpm workspace subpackage (ancestor marker only)', () => {
    // Round 32: a pnpm workspace subpackage often has no local pnpm
    // markers — the lockfile lives at the workspace root, and the
    // subpackage's own `package.json` frequently omits the
    // `packageManager` field. Before the ancestor-walking fix,
    // `isPnpmProject(root, pkg)` returned false for that shape and
    // `resolveScaffoldDependencySpec` rewrote the subpackage's bare
    // `@void-sdk/void: "workspace:*"` source spec to the portable
    // `npm:@void-sdk/void@<fallback>` form — which the subsequent
    // workspace install would try to fetch from the registry instead
    // of linking to the local workspace package.
    //
    // With the ancestor walk, the subpackage inherits the workspace
    // root's `pnpm-workspace.yaml` signal, `isPnpm` is true, and the
    // rewrite emits `workspace:@void-sdk/void@*` which pnpm resolves
    // to the local workspace package.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      // Workspace root has no local `packageManager` pin and no
      // pnpm-lock yet — only `pnpm-workspace.yaml` declares the shape.
      const subpkgRoot = join(wsroot, 'packages', 'app');
      mkdirSync(subpkgRoot, { recursive: true });
      writeFileSync(
        join(subpkgRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'ancestor-pnpm-sub',
            private: true,
            type: 'module',
            devDependencies: {
              '@void-sdk/void': 'workspace:*',
            },
          },
          null,
          2,
        ) + '\n',
      );

      ensureVoidDependency(subpkgRoot);

      const pkg = JSON.parse(readFileSync(join(subpkgRoot, 'package.json'), 'utf-8'));
      // Ancestor pnpm markers must be honored: the rewritten `void`
      // spec is pnpm's aliased-workspace form, NOT a published
      // `npm:@void-sdk/void@<fallback>` spec.
      expect(pkg.devDependencies.void).toBe('workspace:@void-sdk/void@*');
      // The pre-existing preview spec is untouched.
      expect(pkg.devDependencies['@void-sdk/void']).toBe('workspace:*');
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('emits the pnpm aliased-workspace form when the workspace root pins pnpm via Corepack (ancestor marker only)', () => {
    // Round 32: the ancestor walk also honors a
    // `package.json#packageManager: pnpm@...` pin at an ancestor
    // workspace root, even when neither `pnpm-workspace.yaml` nor
    // `pnpm-lock.yaml` is present at that root yet. This covers fresh
    // monorepos using the npm/yarn/bun `workspaces` array shape that
    // still pin pnpm via Corepack.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(wsroot, 'package.json'),
        JSON.stringify(
          {
            name: 'ancestor-corepack-pnpm-root',
            private: true,
            workspaces: ['packages/*'],
            packageManager: 'pnpm@10.2.3',
          },
          null,
          2,
        ) + '\n',
      );

      const subpkgRoot = join(wsroot, 'packages', 'app');
      mkdirSync(subpkgRoot, { recursive: true });
      writeFileSync(
        join(subpkgRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'ancestor-corepack-sub',
            private: true,
            type: 'module',
            devDependencies: {
              '@void-sdk/void': 'workspace:*',
            },
          },
          null,
          2,
        ) + '\n',
      );

      ensureVoidDependency(subpkgRoot);

      const pkg = JSON.parse(readFileSync(join(subpkgRoot, 'package.json'), 'utf-8'));
      expect(pkg.devDependencies.void).toBe('workspace:@void-sdk/void@*');
      expect(pkg.devDependencies['@void-sdk/void']).toBe('workspace:*');
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  // Regression for void-sdk/void#6 round 33: round 32's ancestor-walk
  // for pnpm markers returned true for any nested app under a pnpm
  // workspace ancestor — even when the local subpackage had its own
  // explicit, non-pnpm package-manager markers (a `bun.lockb`,
  // `yarn.lock`, or `packageManager: bun@…`/`yarn@…` Corepack pin).
  // That made `resolveScaffoldDependencySpec` emit the pnpm-only
  // `workspace:@void-sdk/void@*` form, and the subsequent bun/yarn
  // install rejected it as invalid. Local package-manager signals
  // must outrank ancestor pnpm markers.

  it('treats a bun subproject under a pnpm workspace ancestor as non-pnpm when a local `bun.lockb` is present', () => {
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      // Ancestor: shaped like a pnpm workspace root.
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

      // Subpackage: has its OWN local `bun.lockb` → bun is the
      // governing manager, not the ancestor pnpm workspace.
      const subpkgRoot = join(wsroot, 'packages', 'app');
      mkdirSync(subpkgRoot, { recursive: true });
      writeFileSync(join(subpkgRoot, 'bun.lockb'), '');
      writeFileSync(
        join(subpkgRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'bun-under-pnpm',
            private: true,
            type: 'module',
            devDependencies: {
              '@void-sdk/void': 'workspace:*',
            },
          },
          null,
          2,
        ) + '\n',
      );

      ensureVoidDependency(subpkgRoot);

      const pkg = JSON.parse(readFileSync(join(subpkgRoot, 'package.json'), 'utf-8'));
      // Bun cannot parse pnpm's `workspace:<alias>@<range>` syntax.
      // The local `bun.lockb` must force the non-pnpm rewrite path,
      // which emits a portable `npm:@void-sdk/void@<version>` spec.
      expect(pkg.devDependencies.void).not.toBe('workspace:@void-sdk/void@*');
      expect(pkg.devDependencies.void).toMatch(/^npm:@void-sdk\/void@/);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('treats a yarn subproject under a pnpm workspace ancestor as non-pnpm when a local `yarn.lock` is present', () => {
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

      const subpkgRoot = join(wsroot, 'packages', 'app');
      mkdirSync(subpkgRoot, { recursive: true });
      writeFileSync(join(subpkgRoot, 'yarn.lock'), '');
      writeFileSync(
        join(subpkgRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'yarn-under-pnpm',
            private: true,
            type: 'module',
            devDependencies: {
              '@void-sdk/void': 'workspace:*',
            },
          },
          null,
          2,
        ) + '\n',
      );

      ensureVoidDependency(subpkgRoot);

      const pkg = JSON.parse(readFileSync(join(subpkgRoot, 'package.json'), 'utf-8'));
      expect(pkg.devDependencies.void).not.toBe('workspace:@void-sdk/void@*');
      expect(pkg.devDependencies.void).toMatch(/^npm:@void-sdk\/void@/);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('treats a local `packageManager: bun@…` Corepack pin as outranking an ancestor pnpm workspace', () => {
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

      const subpkgRoot = join(wsroot, 'packages', 'app');
      mkdirSync(subpkgRoot, { recursive: true });
      // No local lockfile — only the Corepack pin declares the
      // governing manager.
      writeFileSync(
        join(subpkgRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'bun-pin-under-pnpm',
            private: true,
            type: 'module',
            packageManager: 'bun@1.1.0',
            devDependencies: {
              '@void-sdk/void': 'workspace:*',
            },
          },
          null,
          2,
        ) + '\n',
      );

      ensureVoidDependency(subpkgRoot);

      const pkg = JSON.parse(readFileSync(join(subpkgRoot, 'package.json'), 'utf-8'));
      expect(pkg.devDependencies.void).not.toBe('workspace:@void-sdk/void@*');
      expect(pkg.devDependencies.void).toMatch(/^npm:@void-sdk\/void@/);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('still honors the ancestor pnpm walk for a pristine subpackage with no local package-manager markers', () => {
    // Regression guard: round 32's ancestor-walk behavior must still
    // apply when the subpackage has NO local lockfile AND NO local
    // Corepack pin — the "pristine subpackage" case that motivated the
    // round-32 fix. Without this we'd lose the round-32 fix.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

      const subpkgRoot = join(wsroot, 'packages', 'app');
      mkdirSync(subpkgRoot, { recursive: true });
      // No local `packageManager`, no local lockfile of any flavor —
      // this is the pristine pnpm subpackage shape.
      writeFileSync(
        join(subpkgRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'pristine-pnpm-sub',
            private: true,
            type: 'module',
            devDependencies: {
              '@void-sdk/void': 'workspace:*',
            },
          },
          null,
          2,
        ) + '\n',
      );

      ensureVoidDependency(subpkgRoot);

      const pkg = JSON.parse(readFileSync(join(subpkgRoot, 'package.json'), 'utf-8'));
      // Ancestor pnpm marker is honored — this is the round-32 behavior.
      expect(pkg.devDependencies.void).toBe('workspace:@void-sdk/void@*');
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  // Regression for void-sdk/void#6 round 43: `hasAncestorPnpmMarkers`
  // previously returned `true` as soon as it found ANY pnpm marker in
  // any ancestor directory, without verifying that the subpackage was
  // actually declared as a member of that workspace. For a standalone
  // scratch app at e.g. `<wsroot>/scratch/my-app` whose ancestor
  // `pnpm-workspace.yaml` only lists `packages/*`, the old walk
  // misclassified it as pnpm. `resolveScaffoldDependencySpec` then
  // emitted `workspace:@void-sdk/void@*`, but `runInitCommand` correctly
  // detected the app as standalone (via `isWorkspaceSubpackage`) and
  // ran `pnpm install` locally — which then rejected the workspace:
  // spec because the directory isn't a workspace member. The fix ties
  // `hasAncestorPnpmMarkers` to the same membership check.

  it('does NOT emit the pnpm aliased form for a nested scratch app outside the workspace glob', () => {
    // Shape: `<wsroot>/scratch/my-app` under a `pnpm-workspace.yaml`
    // that only declares `packages/*`. The scratch app is NOT a
    // declared member, so the scaffold must fall back to the portable
    // `npm:<alias>@<version>` rewrite — not the pnpm-only
    // `workspace:@void-sdk/void@*` form.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

      const subpkgRoot = join(wsroot, 'scratch', 'my-app');
      mkdirSync(subpkgRoot, { recursive: true });
      writeFileSync(
        join(subpkgRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'nested-scratch-non-member',
            private: true,
            type: 'module',
            devDependencies: {
              '@void-sdk/void': 'workspace:*',
            },
          },
          null,
          2,
        ) + '\n',
      );

      ensureVoidDependency(subpkgRoot);

      const pkg = JSON.parse(readFileSync(join(subpkgRoot, 'package.json'), 'utf-8'));
      // Non-member scratch app must NOT get the pnpm aliased form.
      expect(pkg.devDependencies.void).not.toBe('workspace:@void-sdk/void@*');
      // Falls back to the portable `npm:@void-sdk/void@<version>` form.
      expect(pkg.devDependencies.void).toMatch(/^npm:@void-sdk\/void@/);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('DOES emit the pnpm aliased form when the workspace glob includes the nested path', () => {
    // Symmetric regression guard: when the ancestor workspace root's
    // glob actually matches the nested path, membership holds and
    // `hasAncestorPnpmMarkers` must still return true. Without this
    // guard the round-43 fix could over-restrict and strip out
    // legitimate pnpm membership detection.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'scratch/*'\n");

      const subpkgRoot = join(wsroot, 'scratch', 'my-app');
      mkdirSync(subpkgRoot, { recursive: true });
      writeFileSync(
        join(subpkgRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'nested-scratch-member',
            private: true,
            type: 'module',
            devDependencies: {
              '@void-sdk/void': 'workspace:*',
            },
          },
          null,
          2,
        ) + '\n',
      );

      ensureVoidDependency(subpkgRoot);

      const pkg = JSON.parse(readFileSync(join(subpkgRoot, 'package.json'), 'utf-8'));
      expect(pkg.devDependencies.void).toBe('workspace:@void-sdk/void@*');
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('does NOT treat a lone ancestor pnpm-lock.yaml (no workspace declaration) as pnpm governance', () => {
    // Shape: ancestor has `pnpm-lock.yaml` but NO `pnpm-workspace.yaml`
    // and no `workspaces` field in `package.json`. The ancestor isn't
    // actually a workspace root, so `findWorkspaceRoot` returns
    // `undefined` and the nested app must not inherit pnpm governance
    // from a stray lockfile higher in the tree. Pre-round-43, the
    // ancestor walk would return true on sight of the lockfile alone.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      // A pnpm-lock.yaml sitting at an ancestor directory that is NOT
      // a workspace root — e.g. a parent checkout from another
      // project, or a lockfile left behind by a previous experiment.
      writeFileSync(join(wsroot, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
      writeFileSync(
        join(wsroot, 'package.json'),
        JSON.stringify({ name: 'ancestor-non-workspace', private: true }, null, 2) + '\n',
      );

      const subpkgRoot = join(wsroot, 'nested', 'app');
      mkdirSync(subpkgRoot, { recursive: true });
      writeFileSync(
        join(subpkgRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'ancestor-non-workspace-sub',
            private: true,
            type: 'module',
            devDependencies: {
              '@void-sdk/void': 'workspace:*',
            },
          },
          null,
          2,
        ) + '\n',
      );

      ensureVoidDependency(subpkgRoot);

      const pkg = JSON.parse(readFileSync(join(subpkgRoot, 'package.json'), 'utf-8'));
      // No declared workspace → not pnpm-governed → non-pnpm rewrite.
      expect(pkg.devDependencies.void).not.toBe('workspace:@void-sdk/void@*');
      expect(pkg.devDependencies.void).toMatch(/^npm:@void-sdk\/void@/);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('does NOT treat a yarn/npm/bun ancestor workspace root as pnpm, even for a declared member', () => {
    // Shape: ancestor has a `package.json` with a `workspaces: ["packages/*"]`
    // array (the yarn/npm/bun convention) and a Corepack pin of
    // `yarn@4.0.0`. The subpackage IS a declared member of that
    // workspace, so membership holds — but the workspace is yarn-shaped,
    // not pnpm. Round 43's tightened `hasAncestorPnpmMarkers` must not
    // promote this case onto the pnpm branch, or `ensureVoidDependency`
    // would emit a `workspace:@void-sdk/void@*` spec that the
    // subsequent yarn install rejects.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(wsroot, 'package.json'),
        JSON.stringify(
          {
            name: 'yarn-workspace-root',
            private: true,
            workspaces: ['packages/*'],
            packageManager: 'yarn@4.0.0',
          },
          null,
          2,
        ) + '\n',
      );

      const subpkgRoot = join(wsroot, 'packages', 'my-app');
      mkdirSync(subpkgRoot, { recursive: true });
      writeFileSync(
        join(subpkgRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'yarn-workspace-member',
            private: true,
            type: 'module',
            devDependencies: {
              '@void-sdk/void': 'workspace:*',
            },
          },
          null,
          2,
        ) + '\n',
      );

      ensureVoidDependency(subpkgRoot);

      const pkg = JSON.parse(readFileSync(join(subpkgRoot, 'package.json'), 'utf-8'));
      // Yarn workspace shape — no pnpm markers at the root — must
      // fall back to the portable `npm:<alias>@<version>` form.
      expect(pkg.devDependencies.void).not.toBe('workspace:@void-sdk/void@*');
      expect(pkg.devDependencies.void).toMatch(/^npm:@void-sdk\/void@/);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('does NOT add a duplicate `void` entry when `void` is already declared in `peerDependencies`', () => {
    // Regression for codex review issue #4: the previous "already
    // declared" check only looked at `dependencies` and `devDependencies`,
    // so a project with `peerDependencies.void` (e.g. a plugin author)
    // got a redundant `devDependencies.void` written on top, which can
    // confuse package managers and dependency dedup.
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'plugin-with-peer',
            private: true,
            peerDependencies: {
              void: '^1.0.0',
            },
          },
          null,
          2,
        ) + '\n',
      );

      ensureVoidDependency(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(pkg.peerDependencies.void).toBe('^1.0.0');
      expect(pkg.devDependencies?.void).toBeUndefined();
    });
  });

  it('does NOT add a duplicate `void` entry when `void` is already declared in `optionalDependencies`', () => {
    // Same fix scope as the peerDependencies case above.
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'optional-void',
            private: true,
            optionalDependencies: {
              void: '^2.5.1',
            },
          },
          null,
          2,
        ) + '\n',
      );

      ensureVoidDependency(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(pkg.optionalDependencies.void).toBe('^2.5.1');
      expect(pkg.devDependencies?.void).toBeUndefined();
    });
  });
});

describe('toAliasedPreviewSpec', () => {
  // Regression for void-sdk/void#6 round 23: round 20 added a path-form
  // passthrough branch so pnpm monorepos pinning `@void-sdk/void` at a
  // relative path (e.g. `workspace:../packages/void`) would keep that spec
  // for the `void` dep. `resolveScaffoldDependencySpec` also reuses this
  // helper to derive adapter package specs (`@void-sdk/react`, `@void-sdk/
  // vue`, …) from the existing `@void-sdk/void` spec. In that branch the
  // target package differs from the source, so passing the same path
  // through would install the core package under the adapter name — the
  // adapter import in `vite.config.ts` would then fail to resolve its
  // expected exports. The path-form passthrough must gate on source ===
  // target; otherwise fall back to a workspace-wide pin.

  it('leaves a path-form spec unchanged when target equals source', () => {
    // Same-package case: the lookup found the exact preview package we're
    // about to install, so the path still points at the right workspace
    // package. Passthrough preserves the round 20 fix.
    expect(
      toAliasedPreviewSpec(
        '@void-sdk/void',
        'workspace:../packages/void',
        '0.0.0',
        '@void-sdk/void',
      ),
    ).toBe('workspace:../packages/void');
  });

  it('rewrites a path-form spec to `workspace:<target>@*` when target differs from source (isPnpm=true)', () => {
    // Derived-adapter case: source is `@void-sdk/void` (the `void` spec
    // the user pinned), target is the adapter we're resolving. The path
    // points at the core package, not the adapter, so reusing it would
    // install core under the adapter name. Fall back to the workspace-
    // wide pin so pnpm resolves the adapter to whatever version the
    // workspace has. The `workspace:<alias>@<range>` form is pnpm-only,
    // so the `isPnpm=true` flag is required.
    expect(
      toAliasedPreviewSpec(
        '@void-sdk/react',
        'workspace:../packages/void',
        '0.0.0',
        '@void-sdk/void',
        true,
      ),
    ).toBe('workspace:@void-sdk/react@*');
  });

  it('rewrites a `./` path-form spec to `workspace:<target>@*` when target differs from source (isPnpm=true)', () => {
    // Same rationale as `../` but with the current-directory prefix.
    expect(
      toAliasedPreviewSpec(
        '@void-sdk/vue',
        'workspace:./vendor/void',
        '0.0.0',
        '@void-sdk/void',
        true,
      ),
    ).toBe('workspace:@void-sdk/vue@*');
  });

  // Regression for void-sdk/void#6 round 33: earlier rounds emitted
  // `workspace:<alias>@*` unconditionally for path-form sources when the
  // derived target differed from the source. That syntax is pnpm-only —
  // yarn/bun monorepos that pin `@void-sdk/void` at a relative path would
  // receive an invalid `workspace:@void-sdk/react@*` entry and the
  // subsequent install step would fail. Gate the aliased-workspace
  // rewrite on `isPnpm` and fall back to the portable
  // `npm:<alias>@<fallbackVersion>` form for everyone else. `*` is
  // intentionally avoided for the npm form because it would resolve to
  // whatever is latest on the registry and defeat the preview alias.

  it('rewrites a `../` path-form spec to `npm:<target>@<fallback>` when target differs from source and isPnpm=false', () => {
    expect(
      toAliasedPreviewSpec(
        '@void-sdk/react',
        'workspace:../packages/void',
        '0.2.3',
        '@void-sdk/void',
        false,
      ),
    ).toBe('npm:@void-sdk/react@0.2.3');
  });

  it('rewrites a `./` path-form spec to `npm:<target>@<fallback>` when target differs from source and isPnpm=false', () => {
    expect(
      toAliasedPreviewSpec(
        '@void-sdk/vue',
        'workspace:./vendor/void',
        '0.2.3',
        '@void-sdk/void',
        false,
      ),
    ).toBe('npm:@void-sdk/vue@0.2.3');
  });

  it('leaves a `./` path-form spec unchanged when target equals source', () => {
    // Same-package case for the current-directory prefix variant.
    expect(
      toAliasedPreviewSpec('@void-sdk/void', 'workspace:./vendor/void', '0.0.0', '@void-sdk/void'),
    ).toBe('workspace:./vendor/void');
  });

  // Regression for void-sdk/void#6 round 26: rounds 23-25 emitted the pnpm-
  // specific `workspace:<alias>@<range>` form unconditionally for any bare
  // `workspace:*` / `workspace:^x.y.z` source. Yarn Berry and Bun workspaces
  // don't understand that syntax — a non-pnpm workspace that had
  // `@void-sdk/void: "workspace:*"` in devDependencies would end up with a
  // `void: "workspace:@void-sdk/void@*"` entry that the subsequent install
  // rejects as invalid. Gate the aliased-workspace rewrite on `isPnpm` and
  // fall back to the portable `npm:<alias>@<range>` form for everyone else
  // (npm, yarn, bun all accept it).

  it('emits the pnpm aliased-workspace form for a bare `workspace:*` when isPnpm=true', () => {
    expect(
      toAliasedPreviewSpec('@void-sdk/void', 'workspace:*', '0.0.0', '@void-sdk/void', true),
    ).toBe('workspace:@void-sdk/void@*');
  });

  it('emits the pnpm aliased-workspace form for a bare `workspace:^1.2.3` when isPnpm=true', () => {
    expect(
      toAliasedPreviewSpec('@void-sdk/void', 'workspace:^1.2.3', '0.0.0', '@void-sdk/void', true),
    ).toBe('workspace:@void-sdk/void@^1.2.3');
  });

  it('falls back to `npm:<alias>@<fallback>` for a bare `workspace:*` when isPnpm=false', () => {
    // Non-pnpm workspaces (yarn berry, bun) don't understand
    // `workspace:<alias>@<range>`. Fall back to the portable npm alias
    // form so every package manager accepts it. `workspace:*` carries no
    // explicit range, so use the caller's fallback (the installed void
    // version) instead of an unpinned `*` that would resolve to whatever
    // is latest on npm and defeat the point of the preview alias.
    expect(
      toAliasedPreviewSpec('@void-sdk/void', 'workspace:*', '0.2.3', '@void-sdk/void', false),
    ).toBe('npm:@void-sdk/void@0.2.3');
  });

  it('falls back to `npm:<alias>@<range>` for a bare `workspace:^1.2.3` when isPnpm=false', () => {
    // Same portability rationale as `workspace:*`, but with an explicit
    // semver range that must be preserved (not replaced with the
    // fallback version).
    expect(
      toAliasedPreviewSpec('@void-sdk/void', 'workspace:^1.2.3', '0.0.0', '@void-sdk/void', false),
    ).toBe('npm:@void-sdk/void@^1.2.3');
  });

  // Regression for void-sdk/void#6 round 32: `workspace:^` and
  // `workspace:~` are valid pnpm shorthands meaning "current workspace
  // version, published with caret/tilde". The bare modifier on its own
  // is NOT a valid semver, so rewrites that paste it directly into a
  // `workspace:<alias>@^` or `npm:<alias>@^` produce a spec every
  // package manager rejects. Treat these (and the unpinned `*` / empty
  // forms) as "no meaningful range" and fall back to `*` (pnpm) or the
  // caller's fallback version (non-pnpm).

  it('treats `workspace:^` as "no meaningful range" on pnpm', () => {
    expect(
      toAliasedPreviewSpec('@void-sdk/void', 'workspace:^', '0.0.0', '@void-sdk/void', true),
    ).toBe('workspace:@void-sdk/void@*');
  });

  it('treats `workspace:~` as "no meaningful range" on pnpm', () => {
    expect(
      toAliasedPreviewSpec('@void-sdk/void', 'workspace:~', '0.0.0', '@void-sdk/void', true),
    ).toBe('workspace:@void-sdk/void@*');
  });

  it('treats `workspace:^` as "no meaningful range" on non-pnpm', () => {
    expect(
      toAliasedPreviewSpec('@void-sdk/void', 'workspace:^', '0.2.3', '@void-sdk/void', false),
    ).toBe('npm:@void-sdk/void@0.2.3');
  });

  it('treats `workspace:~` as "no meaningful range" on non-pnpm', () => {
    expect(
      toAliasedPreviewSpec('@void-sdk/void', 'workspace:~', '0.2.3', '@void-sdk/void', false),
    ).toBe('npm:@void-sdk/void@0.2.3');
  });

  it('rewrites `workspace:1.2.3` to the pnpm aliased form on pnpm', () => {
    // Pinned exact versions are valid semver ranges and must be
    // preserved through the rewrite — they pin the adapter / void dep
    // to a specific version in the workspace.
    expect(
      toAliasedPreviewSpec('@void-sdk/void', 'workspace:1.2.3', '0.0.0', '@void-sdk/void', true),
    ).toBe('workspace:@void-sdk/void@1.2.3');
  });

  it('rewrites `workspace:1.2.3` to the npm alias form on non-pnpm', () => {
    expect(
      toAliasedPreviewSpec('@void-sdk/void', 'workspace:1.2.3', '0.0.0', '@void-sdk/void', false),
    ).toBe('npm:@void-sdk/void@1.2.3');
  });

  it('rewrites `workspace:` (bare, no suffix) to the pnpm aliased form on pnpm', () => {
    expect(
      toAliasedPreviewSpec('@void-sdk/void', 'workspace:', '0.0.0', '@void-sdk/void', true),
    ).toBe('workspace:@void-sdk/void@*');
  });

  it('falls back to `npm:<alias>@<fallback>` for `workspace:` (bare) on non-pnpm', () => {
    expect(
      toAliasedPreviewSpec('@void-sdk/void', 'workspace:', '0.2.3', '@void-sdk/void', false),
    ).toBe('npm:@void-sdk/void@0.2.3');
  });

  it('leaves a plain semver spec untouched (not a workspace form)', () => {
    // Regression guard: the new `workspace:` handling must not touch
    // a plain semver spec — those specs fall through to the npm-alias
    // branch at the bottom of the function.
    expect(toAliasedPreviewSpec('@void-sdk/void', '^1.0.0', '0.0.0', '@void-sdk/void', false)).toBe(
      'npm:@void-sdk/void@^1.0.0',
    );
  });
});

describe('detectProjectState', () => {
  // Regression for void-sdk/void#6 round 21: when a repo pins a non-npm
  // package manager via `package.json#packageManager` (Corepack field) but
  // hasn't committed a lockfile yet, `detectProjectState` previously fell
  // back to `npm`. The demo-scaffold path then ran `npm install` on
  // pnpm/yarn workspaces, corrupting lockfiles or rejecting `workspace:`
  // specs and aborting before `generateStarterMigration()` could run.
  it('prefers package.json#packageManager when no lockfile is present (pnpm)', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'app', packageManager: 'pnpm@10.2.3' }, null, 2) + '\n',
      );
      expect(detectProjectState(root).packageManager).toBe('pnpm');
    });
  });

  it('prefers package.json#packageManager when no lockfile is present (yarn berry pin)', () => {
    // Regression for void-sdk/void#6 round 33: earlier rounds fell back to
    // `npm` for fresh Yarn projects out of fear that Yarn Berry's PnP
    // linker would break the plain-`node` drizzle-kit spawn inside
    // `generateStarterMigration()`. The round-31 post-install PnP check
    // (`.pnp.cjs` / `.pnp.loader.mjs` markers) now skips starter migration
    // cleanly for PnP projects with a note, so fresh Yarn repos should
    // honor the Corepack pin and get the correct install behavior. Falling
    // back to `npm install` on a committed `packageManager: yarn@…` pin
    // creates the wrong lockfile and bypasses Yarn's linker/plugin
    // settings.
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'app', packageManager: 'yarn@4.0.0' }, null, 2) + '\n',
      );
      expect(detectProjectState(root).packageManager).toBe('yarn');
    });
  });

  it('prefers package.json#packageManager when no lockfile is present (yarn classic pin)', () => {
    // Yarn Classic projects usually commit `yarn.lock`, so the lockfile
    // branch catches them. This guards the fresh-repo sliver where only a
    // Corepack `yarn@1.x` pin exists — those projects still want
    // `yarn install`, not `npm install`.
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'app', packageManager: 'yarn@1.22.22' }, null, 2) + '\n',
      );
      expect(detectProjectState(root).packageManager).toBe('yarn');
    });
  });

  it('prefers a committed yarn.lock over a Corepack yarn field', () => {
    // The lockfile branch must still pick up Yarn Classic projects — they
    // commit `yarn.lock` and use `node_modules`, so drizzle-kit resolution
    // works. Only the no-lockfile Corepack sliver falls back to npm.
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'app', packageManager: 'yarn@4.0.0' }, null, 2) + '\n',
      );
      writeFileSync(join(root, 'yarn.lock'), '# yarn lockfile v1\n');
      expect(detectProjectState(root).packageManager).toBe('yarn');
    });
  });

  it('prefers package.json#packageManager when no lockfile is present (bun)', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'app', packageManager: 'bun@1.1.0' }, null, 2) + '\n',
      );
      expect(detectProjectState(root).packageManager).toBe('bun');
    });
  });

  it('honors the Corepack integrity suffix on the packageManager field', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'app', packageManager: 'pnpm@10.2.3+sha512.abcdef' }, null, 2) +
          '\n',
      );
      expect(detectProjectState(root).packageManager).toBe('pnpm');
    });
  });

  it('prefers a committed lockfile over the packageManager field', () => {
    // Lockfile is the stronger signal about what the project actually has
    // installed; the packageManager field is only consulted as a fallback.
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'app', packageManager: 'yarn@4.0.0' }, null, 2) + '\n',
      );
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
      expect(detectProjectState(root).packageManager).toBe('pnpm');
    });
  });

  it('falls back to npm when neither lockfile nor packageManager field is present', () => {
    withTempDir((root) => {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }, null, 2) + '\n');
      expect(detectProjectState(root).packageManager).toBe('npm');
    });
  });

  it('ignores unrecognized packageManager names', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'app', packageManager: 'cnpm@1.0.0' }, null, 2) + '\n',
      );
      expect(detectProjectState(root).packageManager).toBe('npm');
    });
  });

  it('treats pnpm-workspace.yaml as a pnpm signal when no lockfile is present', () => {
    // Regression for void-sdk/void#6 round 37: a fresh pnpm workspace whose
    // only pnpm marker is `pnpm-workspace.yaml` (no `pnpm-lock.yaml` yet,
    // no `package.json#packageManager` pin) used to fall through to `npm`.
    // The demo-scaffold follow-up install then ran `npm install`, which
    // either rejects `workspace:` specs outright or creates a stray
    // `package-lock.json` in a pnpm workspace. `isPnpmProject()` already
    // treats `pnpm-workspace.yaml` as authoritative — `detectProjectState`
    // must agree so the install step uses the right manager.
    withTempDir((root) => {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }, null, 2) + '\n');
      writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      expect(detectProjectState(root).packageManager).toBe('pnpm');
    });
  });

  it('prefers a committed yarn.lock over pnpm-workspace.yaml', () => {
    // The lockfile check order is authoritative — a concrete lockfile is
    // a stronger signal than a workspace-root marker, and the lockfile
    // describes what is actually installed. A repo that somehow committed
    // both files should follow the lockfile.
    withTempDir((root) => {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }, null, 2) + '\n');
      writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      writeFileSync(join(root, 'yarn.lock'), '# yarn lockfile v1\n');
      expect(detectProjectState(root).packageManager).toBe('yarn');
    });
  });
});

describe('generateStarterMigration', () => {
  // Regression for void-sdk/void#6 round 43: when `drizzle-kit generate`
  // crashes mid-write — truncated journal, partial snapshot, or an
  // interrupted write during `void init` — `generateStarterMigration`
  // previously threw without cleaning up the partial artifacts it had
  // planted in `db/migrations/`. The next `void db status` /
  // `void db generate` / `void gen migration` then hit
  // `assertJournalCoherence` and refused to proceed, wedging the repo
  // until the user manually deleted `db/migrations/`. The fix snapshots
  // everything drizzle-kit might touch before spawning, then
  // restores/unlinks on failure. Mirrors the rollback pattern in
  // `gen.ts`'s `generateCustomMigration`, extended to handle the
  // "migrations dir didn't exist yet" case that's unique to the
  // starter path.

  function seedStarterSchema(root: string, dialect: 'sqlite' | 'postgresql'): void {
    mkdirSync(join(root, 'db'), { recursive: true });
    writeFileSync(
      join(root, 'db', 'schema.ts'),
      dialect === 'postgresql'
        ? 'import { sqliteTable } from "void/schema-pg";\nexport const messages = sqliteTable("messages", {});\n'
        : 'import { sqliteTable } from "void/schema-d1";\nexport const messages = sqliteTable("messages", {});\n',
    );
  }

  it('rolls back partial artifacts when drizzle-kit fails and migrations/ did not exist before', () => {
    // Empty-dir case: `db/migrations/` does not exist at all before
    // the spawn. Drizzle-kit plants a partial journal + one partial
    // snapshot, then exits non-zero. Rollback must nuke both the
    // snapshot/journal files AND the `meta/` directory so the next
    // retry is not wedged on a coherence check.
    withTempDir((root) => {
      seedStarterSchema(root, 'sqlite');
      mockSpawnSync.mockImplementationOnce((command, args, options) => {
        if (
          command === process.execPath &&
          Array.isArray(args) &&
          args[1] === 'generate' &&
          options &&
          typeof options === 'object' &&
          'cwd' in options &&
          typeof options.cwd === 'string'
        ) {
          // Plant a partial journal + snapshot mid-write before
          // "crashing" with a non-zero exit.
          const migrationsDir = join(options.cwd, 'db', 'migrations');
          const metaDir = join(migrationsDir, 'meta');
          mkdirSync(metaDir, { recursive: true });
          writeFileSync(
            join(metaDir, '_journal.json'),
            '{"version":"7","dialect":"sqlite","entries":[',
          );
          writeFileSync(join(metaDir, '0000_snapshot.json'), '{"partial":true');
          writeFileSync(join(migrationsDir, '0000_generated.sql'), '-- partially written sql\n');
        }
        return {
          status: 1,
          stdout: '',
          stderr: 'drizzle-kit: simulated crash',
        };
      });

      expect(() => generateStarterMigration(root, 'sqlite')).toThrow(
        /Failed to generate the starter database migration/,
      );

      // Rollback must have removed everything the failed spawn
      // planted. The meta/ dir and the journal must be gone because
      // they didn't exist before the spawn.
      expect(existsSync(join(root, 'db', 'migrations', 'meta', '_journal.json'))).toBe(false);
      expect(existsSync(join(root, 'db', 'migrations', 'meta', '0000_snapshot.json'))).toBe(false);
      // Best-effort — the meta/ dir itself may or may not be removed,
      // but it must at least be empty so subsequent retries are not
      // blocked by partial artifacts.
      if (existsSync(join(root, 'db', 'migrations', 'meta'))) {
        expect(readdirSync(join(root, 'db', 'migrations', 'meta'))).toEqual([]);
      }
      // No fresh .sql files in migrations/.
      const sqlFiles = existsSync(join(root, 'db', 'migrations'))
        ? readdirSync(join(root, 'db', 'migrations')).filter((f) => f.endsWith('.sql'))
        : [];
      expect(sqlFiles).toEqual([]);
    });
  });

  it('restores the journal and keeps prior entries when drizzle-kit fails and a journal existed before', () => {
    // Existing-journal case: `db/migrations/meta/_journal.json` is
    // already on disk with some known content, plus a prior
    // `0000_prev.sql` and `0000_snapshot.json`. The spawn overwrites
    // the journal, plants a new `0001_new.sql` / `0001_snapshot.json`,
    // then exits non-zero. Rollback must:
    //   - byte-restore the original journal
    //   - preserve `0000_prev.sql` and `0000_snapshot.json`
    //   - unlink the new `0001_new.sql` and `0001_snapshot.json`
    withTempDir((root) => {
      seedStarterSchema(root, 'sqlite');
      const migrationsDir = join(root, 'db', 'migrations');
      const metaDir = join(migrationsDir, 'meta');
      mkdirSync(metaDir, { recursive: true });

      const originalJournal =
        JSON.stringify(
          {
            version: '7',
            dialect: 'sqlite',
            entries: [{ idx: 0, version: '6', when: 0, tag: '0000_prev', breakpoints: true }],
          },
          null,
          2,
        ) + '\n';
      writeFileSync(join(metaDir, '_journal.json'), originalJournal);
      writeFileSync(
        join(metaDir, '0000_snapshot.json'),
        JSON.stringify({ version: '6', dialect: 'sqlite' }, null, 2) + '\n',
      );
      writeFileSync(
        join(migrationsDir, '0000_prev.sql'),
        'CREATE TABLE existing (id INTEGER PRIMARY KEY);\n',
      );

      mockSpawnSync.mockImplementationOnce((command, args, options) => {
        if (
          command === process.execPath &&
          Array.isArray(args) &&
          args[1] === 'generate' &&
          options &&
          typeof options === 'object' &&
          'cwd' in options &&
          typeof options.cwd === 'string'
        ) {
          const cwdMigrationsDir = join(options.cwd, 'db', 'migrations');
          const cwdMetaDir = join(cwdMigrationsDir, 'meta');
          // Overwrite the journal with a corrupted / partial write.
          writeFileSync(join(cwdMetaDir, '_journal.json'), '{"truncated":true');
          // Plant a new snapshot + sql file for a migration that
          // never finishes.
          writeFileSync(join(cwdMetaDir, '0001_snapshot.json'), '{"new":"partial"');
          writeFileSync(join(cwdMigrationsDir, '0001_new.sql'), '-- half-written new migration\n');
        }
        return {
          status: 1,
          stdout: '',
          stderr: 'drizzle-kit: simulated crash',
        };
      });

      expect(() => generateStarterMigration(root, 'sqlite')).toThrow(
        /Failed to generate the starter database migration/,
      );

      // Journal must be byte-restored.
      expect(readFileSync(join(metaDir, '_journal.json'), 'utf-8')).toBe(originalJournal);
      // Prior migration artifacts must still exist.
      expect(existsSync(join(metaDir, '0000_snapshot.json'))).toBe(true);
      expect(existsSync(join(migrationsDir, '0000_prev.sql'))).toBe(true);
      // Fresh partial artifacts must be gone.
      expect(existsSync(join(metaDir, '0001_snapshot.json'))).toBe(false);
      expect(existsSync(join(migrationsDir, '0001_new.sql'))).toBe(false);
    });
  });

  it('leaves all new artifacts in place on the success path', () => {
    // Regression guard: the rollback path must only fire when the
    // spawn fails. On a successful spawn, every file drizzle-kit
    // wrote (journal, snapshot, sql migration) must survive untouched.
    withTempDir((root) => {
      seedStarterSchema(root, 'sqlite');

      // The default beforeEach mock already writes a full mock
      // migration on success — let it run.
      generateStarterMigration(root, 'sqlite');

      expect(existsSync(join(root, 'db', 'migrations', '0000_generated.sql'))).toBe(true);
      expect(existsSync(join(root, 'db', 'migrations', 'meta', '_journal.json'))).toBe(true);
      expect(existsSync(join(root, 'db', 'migrations', 'meta', '0000_snapshot.json'))).toBe(true);
      // Sanity: journal is non-empty and mentions the generated entry.
      expect(
        readFileSync(join(root, 'db', 'migrations', 'meta', '_journal.json'), 'utf-8'),
      ).toContain('0000_generated');
    });
  });
});
