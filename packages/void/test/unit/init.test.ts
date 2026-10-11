import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toSlash } from 'pathslash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  detectProjectState,
  ensureVoidDependency,
  ensureVoidWorkerCompatibilityDate,
  ensureVoidPlatformConnection,
  extractPnpmWorkspacePackages,
  generateStarterMigration,
  getWorkflowYaml,
  isScaffoldableEmptyProject,
  isVoidResolvableFrom,
  parseInitArgs,
  runInitCommand,
} from '../../src/cli/init.ts';
import { savePlatformConnection } from '../../src/cli/platform-registry.ts';
import { LATEST_KNOWN_COMPAT_DATE } from '../../src/cli/wrangler.ts';
import { buildDrizzleKitSpawnEnv } from '../../src/cli/yarn-pnp.ts';
import { readConfig } from '../../src/config.ts';

const mockSpawnSync = vi.fn();
const mockSelect = vi.fn();
const mockConfirm = vi.fn();
const mockText = vi.fn();
const mockNote = vi.fn();
const mockOutro = vi.fn();
const mockLogWarn = vi.fn();
const mockGetToken = vi.fn();
const mockGetApiUrl = vi.fn();
const mockRunLogin = vi.fn();
const mockSaveToken = vi.fn();
const mockIsStagingMode = vi.fn();
const mockListProjects = vi.fn();
const mockCreateProject = vi.fn();
const mockDiscoverPlatform = vi.fn();
let platformRegistryDirectory: string;

it('pins compatibility date in the lock without rewriting authored TypeScript', () => {
  const root = mkdtempSync(join(tmpdir(), 'void-init-authored-config-'));
  const source =
    "import { defineConfig } from 'void/config';\nexport default defineConfig({ remote: process.env.REMOTE === '1' });\n";
  try {
    writeFileSync(join(root, 'void.config.ts'), source);
    ensureVoidWorkerCompatibilityDate(root);
    expect(readFileSync(join(root, 'void.config.ts'), 'utf8')).toBe(source);
    const lock = JSON.parse(readFileSync(join(root, 'void.lock.json'), 'utf8'));
    expect(lock.resolved.compatibility_date).toBe(LATEST_KNOWN_COMPAT_DATE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('keeps an existing typed Astro adapter with dynamic options during targeted init', async () => {
  const root = mkdtempSync(join(tmpdir(), 'void-init-typed-astro-'));
  const adapter =
    'import cloudflare from "@astrojs/cloudflare"; const options = { configPath: "./.void-wrangler.jsonc" }; export default { adapter: cloudflare(options) };\n';
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { astro: '*' } }));
    writeFileSync(
      join(root, 'void.config.ts'),
      'export default { cloudflare: { name: "app" } };\n',
    );
    writeFileSync(join(root, 'astro.config.ts'), adapter);

    await runInitCommand(root, { tsconfig: true, github: false });
    expect(readFileSync(join(root, 'astro.config.ts'), 'utf8')).toBe(adapter);
    expect(existsSync(join(root, 'wrangler.jsonc'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('init Git arguments', () => {
  it('keeps Git optional and honors the last positive or negative flag', () => {
    expect(parseInitArgs([]).git).toBeUndefined();
    expect(parseInitArgs(['--git']).git).toBe(true);
    expect(parseInitArgs(['--no-git']).git).toBe(false);
    expect(parseInitArgs(['--git', '--no-git']).git).toBe(false);
    expect(parseInitArgs(['--no-git', '--git']).git).toBe(true);
    expect(parseInitArgs(['--tsconfig', '--git'])).toMatchObject({ tsconfig: true, git: true });
    expect(() => parseInitArgs(['--agents'])).toThrow('Unknown option');
  });

  it.each(['--git', '--no-git'])('keeps the full starter flow with %s', async (flag) => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-git-flow-'));
    try {
      mockSelect
        .mockResolvedValueOnce('vite')
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('static')
        .mockResolvedValueOnce('none');
      await runInitCommand(root, parseInitArgs([flag]));
      expect(existsSync(join(root, 'pages', 'index.tsx'))).toBe(true);
      expect(existsSync(join(root, '.gitignore'))).toBe(true);
      const gitCalls = mockSpawnSync.mock.calls.filter(([command]) => command === 'git');
      expect(gitCalls).toHaveLength(flag === '--git' ? 1 : 0);
      if (flag === '--git') {
        expect(gitCalls[0][1]).toEqual(['init']);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['--git', '--no-git'])(
    'rejects %s in a workspace member before modifying it',
    async (flag) => {
      const root = mkdtempSync(join(tmpdir(), 'void-init-git-workspace-'));
      try {
        writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['apps/*'] }));
        const child = join(root, 'apps', 'web');
        mkdirSync(child, { recursive: true });
        await expect(runInitCommand(child, parseInitArgs(['--tsconfig', flag]))).rejects.toThrow(
          'The --git/--no-git options are not available when adding a package to an existing monorepo',
        );
        expect(readdirSync(child)).toEqual([]);
        expect(mockSpawnSync).not.toHaveBeenCalled();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe('GitHub Actions deployment workflows', () => {
  it('requires a selected URL for a Void deployment workflow', () => {
    expect(() => getWorkflowYaml('/project', 'npm', 'my-app', 'void')).toThrow('void connect');
  });
  it('scaffolds the direct Cloudflare deployment path with a scoped API token', () => {
    const yaml = getWorkflowYaml('/project', 'npm', null, 'cloudflare');
    expect(yaml).toContain('name: Deploy to Cloudflare');
    expect(yaml).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(yaml).toContain('DATABASE_URL: ${{ secrets.DATABASE_URL }}');
    expect(yaml).toContain(
      'CLOUDFLARE_WORKERS_SUBDOMAIN: ${{ vars.CLOUDFLARE_WORKERS_SUBDOMAIN }}',
    );
    expect(yaml).toContain('CF_ACCESS_CLIENT_ID: ${{ secrets.CF_ACCESS_CLIENT_ID }}');
    expect(yaml).toContain('CF_ACCESS_CLIENT_SECRET: ${{ secrets.CF_ACCESS_CLIENT_SECRET }}');
    expect(yaml).toContain('npx void deploy --platform cloudflare');
    expect(yaml).toContain('contents: read');
    expect(yaml).not.toContain('id-token: write');
    expect(yaml).not.toContain('VOID_TOKEN');
  });

  it('retains the GitHub OIDC workflow for managed deployments', () => {
    const yaml = getWorkflowYaml(
      '/project',
      'npm',
      'my-app',
      'void',
      'https://api.company.example',
    );
    expect(yaml).toContain('name: Deploy to Void');
    expect(yaml).toContain('id-token: write');
    expect(yaml).toContain(
      "VOID_API_URL: ${{ vars.VOID_API_URL || 'https://api.company.example' }}",
    );
    expect(yaml).toContain('npx void connect "$VOID_API_URL" --no-login');
    expect(yaml.indexOf('npx void connect')).toBeLessThan(yaml.indexOf('npx void deploy'));
    expect(yaml).toContain('npx void deploy --platform void --project "$VOID_PROJECT"');
  });
});

function expectPnpmAllowBuilds(root: string): void {
  const yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf-8');
  expect(yaml).toContain('allowBuilds:\n');
  expect(yaml).toContain('  better-sqlite3: false');
  expect(yaml).toContain('  esbuild: true');
  expect(yaml).toContain('  sharp: true');
  expect(yaml).toContain('  workerd: true');
  expect(yaml).not.toContain('onlyBuiltDependencies:');
}

vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  settings: { accessible: false },
  intro: vi.fn(),
  outro: (...args: Array<unknown>) => mockOutro(...args),
  note: (...args: Array<unknown>) => mockNote(...args),
  log: {
    success: vi.fn(),
    warn: (...args: Array<unknown>) => mockLogWarn(...args),
    error: vi.fn(),
    info: vi.fn(),
    step: vi.fn(),
  },
  confirm: (...args: Array<unknown>) => mockConfirm(...args),
  select: (...args: Array<unknown>) => mockSelect(...args),
  text: (...args: Array<unknown>) => mockText(...args),
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
  isCI: () => false,
  isCancel: (value: unknown) => value === Symbol.for('cancel'),
  cancel: vi.fn(),
}));

vi.mock('../../src/cli/auth', () => ({
  getApiUrl: (...args: Array<unknown>) => mockGetApiUrl(...args),
  getToken: (...args: Array<unknown>) => mockGetToken(...args),
  runPlatformLogin: (...args: Array<unknown>) => mockRunLogin(...args),
  savePlatformToken: (...args: Array<unknown>) => mockSaveToken(...args),
  isStagingMode: (...args: Array<unknown>) => mockIsStagingMode(...args),
  getSiteDomain: () => 'void.app',
}));

vi.mock('../../src/cli/platform-cmd', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/platform-cmd.ts')>()),
  discoverPlatform: (...args: Array<unknown>) => mockDiscoverPlatform(...args),
}));

vi.mock('../../src/cli/client', () => ({
  PlatformApiError: class PlatformApiError extends Error {
    readonly status = 500;
    readonly code = undefined;
    readonly body = undefined;
  },
  PlatformClient: class {
    readonly apiUrl: string;

    constructor(_token: string, options?: string | { apiUrl?: string }) {
      this.apiUrl =
        (typeof options === 'string' ? options : options?.apiUrl) ??
        mockGetApiUrl() ??
        'https://api.example.com';
    }

    listProjects(...args: Array<unknown>) {
      return mockListProjects(...args);
    }

    createProject(...args: Array<unknown>) {
      return mockCreateProject(...args);
    }
  },
}));

vi.mock('node:child_process', () => ({
  spawnSync: (...args: Array<unknown>) => mockSpawnSync(...args),
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

function listMigrationSqlFiles(root: string): Array<string> {
  const migrationsDir = join(root, 'db', 'migrations');
  if (!existsSync(migrationsDir)) {
    return [];
  }
  return readdirSync(migrationsDir)
    .filter((entry) => entry.endsWith('.sql'))
    .sort();
}

function writeExistingAstroProject(root: string): void {
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(
      { name: 'existing-astro-app', private: true, dependencies: { astro: '^5.0.0' } },
      null,
      2,
    ) + '\n',
  );
}

function selectCloudflareDuringInit(accountId?: string): void {
  mockSelect.mockImplementation((options: { message?: string }) => {
    switch (options.message) {
      case 'Choose a database setup for this project:':
        return 'none';
      case 'Where should this project deploy?':
        return 'cloudflare';
      case 'Choose a Cloudflare account:':
        return accountId;
      default:
        return undefined;
    }
  });
}

function wranglerWhoamiResult(accounts: Array<{ id: string; name: string }>): {
  status: number;
  stdout: string;
  stderr: string;
} {
  return {
    status: 0,
    stdout: JSON.stringify({ operationResult: 1, data: { loggedIn: true, accounts, scopes: [] } }),
    stderr: '',
  };
}

function cloudflareOperationType(args: unknown): string | undefined {
  if (!Array.isArray(args)) {
    return undefined;
  }
  try {
    return JSON.parse(args.at(-1)).type;
  } catch {
    return undefined;
  }
}

afterEach(() => {
  delete process.env.VOID_PLATFORM_REGISTRY_DIR;
  rmSync(platformRegistryDirectory, { recursive: true, force: true });
  mockSpawnSync.mockReset();
  mockSelect.mockReset();
  mockConfirm.mockReset();
  mockText.mockReset();
  mockNote.mockReset();
  mockOutro.mockReset();
  mockLogWarn.mockReset();
  mockGetToken.mockReset();
  mockGetApiUrl.mockReset();
  mockRunLogin.mockReset();
  mockSaveToken.mockReset();
  mockIsStagingMode.mockReset();
  mockListProjects.mockReset();
  mockCreateProject.mockReset();
  mockDiscoverPlatform.mockReset();
});

beforeEach(() => {
  platformRegistryDirectory = mkdtempSync(join(tmpdir(), 'void-init-platform-registry-'));
  process.env.VOID_PLATFORM_REGISTRY_DIR = platformRegistryDirectory;
  savePlatformConnection({
    accountId: null,
    apiUrl: 'https://api.void.cloud',
    applicationDomain: 'void.app',
    displayName: 'Void Cloud',
    installationId: null,
    kind: 'connected',
    proxyUrl: 'https://proxy.void.cloud',
  });
  mockSelect.mockImplementation((options: { message?: string }) =>
    options.message === 'Where should this project deploy?' ? 'void' : undefined,
  );
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
  mockGetApiUrl.mockReturnValue('https://api.void.cloud');
  mockRunLogin.mockResolvedValue('token_123');
  mockIsStagingMode.mockReturnValue(false);
  mockListProjects.mockResolvedValue([]);
  mockCreateProject.mockResolvedValue({ id: 'proj_123', slug: 'my-app' });
  mockDiscoverPlatform.mockResolvedValue({
    apiUrl: 'https://api.void.cloud',
    applicationDomain: 'void.app',
    authenticationProviders: ['github', 'google'],
    capabilities: {
      ai: true,
      customDomains: true,
      email: true,
      githubActions: true,
      githubOAuth: true,
      googleOAuth: true,
      managedBuilds: true,
      sandbox: true,
    },
    displayName: 'Void Cloud',
    installationId: null,
    platformVersion: '0.10.14',
    proxyUrl: 'https://proxy.void.cloud',
    schemaVersion: 1,
  });
});

describe('Void platform deployment setup', () => {
  it('connects a genuinely new user before attempting platform login', async () => {
    rmSync(platformRegistryDirectory, { force: true, recursive: true });
    mockGetApiUrl.mockImplementation(() => {
      throw new Error('No Void platform connected');
    });
    mockText.mockResolvedValue('https://platform.example.test');
    mockDiscoverPlatform.mockResolvedValueOnce({
      apiUrl: 'https://platform.example.test',
      applicationDomain: 'apps.example.test',
      authenticationProviders: ['github'],
      capabilities: {
        ai: true,
        customDomains: true,
        email: false,
        githubActions: false,
        githubOAuth: true,
        googleOAuth: false,
        managedBuilds: false,
        sandbox: false,
      },
      displayName: 'Company Void',
      installationId: 'company-a1b2c3d4',
      platformVersion: '0.10.14',
      proxyUrl: 'https://proxy.example.test',
      schemaVersion: 1,
    });

    await ensureVoidPlatformConnection('/project');

    expect(mockDiscoverPlatform).toHaveBeenCalledWith('https://platform.example.test');
    const { getActivePlatformConnection } = await import('../../src/cli/platform-registry.ts');
    expect(getActivePlatformConnection()).toMatchObject({
      apiUrl: 'https://platform.example.test',
      applicationDomain: 'apps.example.test',
      proxyUrl: 'https://proxy.example.test',
    });
  });

  it('refuses to scaffold unsupported platform GitHub Actions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-no-github-actions-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'existing-app', private: true }, null, 2) + '\n',
      );
      mockDiscoverPlatform.mockResolvedValueOnce({
        apiUrl: 'https://platform.example.test',
        applicationDomain: 'apps.example.test',
        authenticationProviders: ['github'],
        capabilities: {
          ai: true,
          customDomains: true,
          email: false,
          githubActions: false,
          githubOAuth: true,
          googleOAuth: false,
          managedBuilds: false,
          sandbox: false,
        },
        displayName: 'Company Void',
        installationId: 'company-a1b2c3d4',
        platformVersion: '0.10.14',
        proxyUrl: 'https://proxy.example.test',
        schemaVersion: 1,
      });

      await expect(runInitCommand(root, { github: true, tsconfig: false })).rejects.toThrow(
        'Company Void does not support GitHub Actions deployments',
      );
      expect(existsSync(join(root, '.github', 'workflows', 'void-deploy.yml'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('extractPnpmWorkspacePackages', () => {
  it('parses block-style packages list with mixed quoting', () => {
    const yaml = ['packages:', "  - 'packages/*'", '  - "apps/*"', '  - docs', ''].join('\n');
    expect(extractPnpmWorkspacePackages(yaml)).toEqual(['packages/*', 'apps/*', 'docs']);
  });

  it('parses inline flow-style list with a single quoted element', () => {
    // Real pnpm manifests also accept the flow-style inline form (e.g.
    // generated by some tooling). Without it, `isWorkspaceSubpackage`
    // falls back to the fresh-clone install path inside a subpackage
    // with `workspace:` specs.
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

  // Comment stripping must respect quoted scalars. Truncating
  // `- "path #hash/*"` to `- "path` would silently fail the
  // `isWorkspaceSubpackage` membership check and misroute a valid
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
  // `.pnp.cjs` / `.pnp.loader.mjs` at an ancestor count as "void is
  // resolvable" — Yarn Berry PnP projects have no `node_modules` tree.
  //
  // The PnP branch additionally requires the post-install marker `.yarn/install-state.gz` in the same directory as the
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

  // Committed-but-unfetched PnP fresh clone — `.pnp.cjs`
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

  // Yarn Berry zero-install repos commit `.yarn/cache/*.zip`
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

  // Inverse of the zero-install case — when `.pnp.cjs` is
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

  // The same-directory invariant — when we find `.pnp.cjs`
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

  // An installed PnP runtime proves that `yarn install` ran at
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
          (call[1] as Array<unknown>)[0] === '-e' &&
          (call[1] as Array<unknown>)[1] === "require.resolve('void')",
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
          (call[1] as Array<unknown>)[0] === '-e' &&
          (call[1] as Array<unknown>)[1] === "require.resolve('void')",
      );
      expect(probeCalls.length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // When only `.pnp.loader.mjs` is
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
          (call[1] as Array<unknown>)[0] === '--input-type=module' &&
          (call[1] as Array<unknown>)[1] === '-e' &&
          (call[1] as Array<unknown>)[2] === "import.meta.resolve('void')",
      );
      expect(esmProbes.length).toBe(1);
      const cjsProbes = mockSpawnSync.mock.calls.filter(
        (call) =>
          Array.isArray(call[1]) &&
          (call[1] as Array<unknown>)[0] === '-e' &&
          (call[1] as Array<unknown>)[1] === "require.resolve('void')",
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
          (call[1] as Array<unknown>)[0] === '--input-type=module' &&
          (call[1] as Array<unknown>)[1] === '-e' &&
          (call[1] as Array<unknown>)[2] === "import.meta.resolve('void')",
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
          (call[1] as Array<unknown>)[0] === '-e' &&
          (call[1] as Array<unknown>)[1] === "require.resolve('void')",
      );
      expect(cjsProbes.length).toBe(1);
      const esmProbes = mockSpawnSync.mock.calls.filter(
        (call) =>
          Array.isArray(call[1]) && (call[1] as Array<unknown>)[0] === '--input-type=module',
      );
      expect(esmProbes.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The `node_modules/void` ancestor walk must short-circuit
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
          (call[1] as Array<unknown>)[0] === '-e' &&
          (call[1] as Array<unknown>)[1] === "require.resolve('void')",
      ).length;

      expect(isVoidResolvableFrom(root)).toBe(true);

      const probeCallsAfter = mockSpawnSync.mock.calls.filter(
        (call) =>
          Array.isArray(call[1]) &&
          (call[1] as Array<unknown>)[0] === '-e' &&
          (call[1] as Array<unknown>)[1] === "require.resolve('void')",
      ).length;
      expect(probeCallsAfter).toBe(probeCallsBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A leaf-managed nested project sitting inside an unrelated Yarn PnP
  // monorepo must not inherit the outer `.pnp.cjs`.
  // `findInstalledYarnPnpRuntime` stops at `start`
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

  // A `packageManager` Corepack pin at
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
          (call[1] as Array<unknown>)[0] === '-e' &&
          (call[1] as Array<unknown>)[1] === "require.resolve('void')",
      );
      expect(probeCalls.length).toBe(1);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
});

// A leaf-managed nested project inside an unrelated Yarn PnP monorepo
// must not get the outer `.pnp.cjs` injected into `NODE_OPTIONS`, or
// drizzle-kit resolves local deps through the outer graph and crashes.
// The gate in `findYarnPnpRuntime` must stop the walk at any directory
// that owns its own install.
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

  // A subpackage that only carries a
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
      expect(env.NODE_OPTIONS).toContain(JSON.stringify(toSlash(join(outer, '.pnp.cjs'))));
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
      expect(env.NODE_OPTIONS).toContain(JSON.stringify(toSlash(join(root, '.pnp.cjs'))));
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
      expect(env.NODE_OPTIONS).toContain(JSON.stringify(toSlash(join(outer, '.pnp.cjs'))));
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

  it('returns true for pnpm add -D void shape with generated pnpm-workspace.yaml', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            devDependencies: {
              void: '^0.8.9',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
      writeFileSync(
        join(root, 'pnpm-workspace.yaml'),
        [
          'allowBuilds:',
          '  better-sqlite3: set this to true or false',
          '  esbuild: set this to true or false',
          '  sharp: set this to true or false',
          '  workerd: set this to true or false',
          'minimumReleaseAgeExclude:',
          '  - void@0.8.9',
          '',
        ].join('\n'),
      );
      mkdirSync(join(root, 'node_modules', 'void'), { recursive: true });
      writeFileSync(join(root, 'node_modules', 'void', 'package.json'), '{"name":"void"}\n');

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
              void: '^0.2.3',
              '@void/react': '^0.2.3',
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

  it('returns false when pnpm-workspace.yaml declares workspace packages', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            devDependencies: {
              void: '^0.8.9',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
      writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

      expect(isScaffoldableEmptyProject(root)).toBe(false);
    });
  });

  it('returns true for a deleted starter that only has manifest and generated state left', () => {
    withTempDir((root) => {
      mkdirSync(join(root, '.void'), { recursive: true });
      mkdirSync(join(root, '.wrangler'), { recursive: true });
      writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({}) + '\n');
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'deleted-starter',
            private: true,
            type: 'module',
            scripts: {
              dev: 'vp dev',
              build: 'vp build',
              preview: 'vp preview',
            },
            dependencies: {
              hono: '^4.11.9',
              svelte: '^5.53.9',
            },
            devDependencies: {
              void: '^0.2.3',
              '@void/svelte': '^0.2.3',
              vite: '^8.0.10',
              'vite-plus': '^0.1.21',
              typescript: '^7.0.2',
            },
          },
          null,
          2,
        ) + '\n',
      );

      expect(isScaffoldableEmptyProject(root)).toBe(true);
    });
  });

  it('replaces stale vp starter scripts when plain Vite is selected', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'stale-vp-starter',
            scripts: {
              dev: 'vp dev',
              build: 'vp build',
              preview: 'vp preview',
            },
          },
          null,
          2,
        ) + '\n',
      );
      mockSelect
        .mockResolvedValueOnce('vite')
        .mockResolvedValueOnce('svelte')
        .mockResolvedValueOnce('static');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(pkg.scripts).toMatchObject({
        dev: 'vite',
        build: 'vite build',
        preview: 'vite preview',
      });
      expect(pkg.devDependencies.vite).toBe('^8.0.10');
      expect(pkg.devDependencies['vite-plus']).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns false when app files already exist', () => {
    withTempDir((root) => {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'main.ts'), "console.log('x');\n");
      expect(isScaffoldableEmptyProject(root)).toBe(false);
    });
  });

  it('returns false when package has non-starter dependencies', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'my-app',
            devDependencies: {
              void: '^0.0.1',
              express: '^4.18.0',
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
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('sqlite');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(pkg.dependencies.react).toBeDefined();
      expect(pkg.dependencies['react-dom']).toBeDefined();
      expect(pkg.dependencies.hono).toBeDefined();
      expect(pkg.devDependencies.vite).toBeDefined();
      expect(pkg.devDependencies['vite-plus']).toBe('^0.1.21');
      expect(pkg.devDependencies.void).toBeDefined();
      expect(pkg.devDependencies.typescript).toBeDefined();
      expect(pkg.devDependencies['@void/react']).toBeDefined();
      expect(pkg.devDependencies['@types/react']).toBeDefined();
      expect(pkg.devDependencies['@types/react-dom']).toBeDefined();
      expect(pkg.devDependencies['oxc-transform-react']).toBeDefined();
      expect(pkg.scripts.dev).toBe('vp dev');
      expect(pkg.scripts.build).toBe('vp build');
      expect(pkg.scripts.preview).toBe('vp preview');

      const reactViteConfig = readFileSync(join(root, 'vite.config.ts'), 'utf-8');
      expect(reactViteConfig).toContain('from "@void/react/plugin"');
      expect(reactViteConfig).toContain('voidReact({ react: { compiler: true } })');
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
      expect(readConfig(root)).toEqual({
        worker: {
          compatibility_date: LATEST_KNOWN_COMPAT_DATE,
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
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('vue')
        .mockResolvedValueOnce('postgresql');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(pkg.dependencies.vue).toBeDefined();
      expect(pkg.devDependencies['@void/vue']).toBeDefined();
      expect(pkg.devDependencies.void).toBeDefined();

      expect(readConfig(root)).toEqual({
        database: 'pg',
        worker: {
          compatibility_date: LATEST_KNOWN_COMPAT_DATE,
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

      const toolchainPrompt = mockSelect.mock.calls[0]?.[0];
      expect(toolchainPrompt.message).toBe('Choose a Pages scaffold toolchain:');
      expect(toolchainPrompt.initialValue).toBe('vite-plus');
      expect(toolchainPrompt.options).toEqual([
        {
          value: 'vite-plus',
          label: 'Vite+',
          hint: 'Uses the Vite+ toolchain and vp commands.',
        },
        {
          value: 'vite',
          label: 'Vite',
          hint: 'Uses plain Vite commands without Vite+.',
        },
      ]);

      const frameworkPrompt = mockSelect.mock.calls[1]?.[0];
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

      const starterPrompt = mockSelect.mock.calls[2]?.[0];
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
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('scaffolds a static Pages starter without database files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      mockSelect
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('static');
      mockConfirm.mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(pkg.dependencies.react).toBeDefined();
      expect(pkg.dependencies['react-dom']).toBeDefined();
      expect(pkg.dependencies.hono).toBeDefined();
      expect(pkg.devDependencies.void).toBeDefined();
      expect(pkg.devDependencies['@void/react']).toBeDefined();
      expect(pkg.devDependencies['vite-plus']).toBe('^0.1.21');
      expect(pkg.packageManager).toBe('pnpm@12.4.1');
      expect(pkg.scripts.dev).toBe('vp dev');

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
      expect(readConfig(root)).toEqual({
        worker: {
          compatibility_date: LATEST_KNOWN_COMPAT_DATE,
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('scaffolds plain Vite scripts when the Vite toolchain is selected', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      mockSelect
        .mockResolvedValueOnce('vite')
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('static');
      mockConfirm.mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(pkg.devDependencies.vite).toBe('^8.0.10');
      expect(pkg.devDependencies['vite-plus']).toBeUndefined();
      expect(pkg.scripts.dev).toBe('vite');
      expect(pkg.scripts.build).toBe('vite build');
      expect(pkg.scripts.preview).toBe('vite preview');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prompts for the scaffold toolchain after pnpm add -D void creates pnpm-workspace.yaml', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            devDependencies: {
              void: '^0.8.9',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
      writeFileSync(
        join(root, 'pnpm-workspace.yaml'),
        [
          'allowBuilds:',
          '  better-sqlite3: set this to true or false',
          '  esbuild: set this to true or false',
          '  sharp: set this to true or false',
          '  workerd: set this to true or false',
          'minimumReleaseAgeExclude:',
          '  - void@0.8.9',
          '',
        ].join('\n'),
      );
      mkdirSync(join(root, 'node_modules', 'void'), { recursive: true });
      writeFileSync(join(root, 'node_modules', 'void', 'package.json'), '{"name":"void"}\n');

      mockSelect
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('static');
      mockConfirm.mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(pkg.scripts.dev).toBe('vp dev');
      expect(pkg.devDependencies['vite-plus']).toBe('^0.1.21');
      expect(pkg.devDependencies.void).toBe('^0.8.9');
      expect(readFileSync(join(root, 'vite.config.ts'), 'utf-8')).toContain(
        'voidReact({ react: { compiler: true } })',
      );
      expectPnpmAllowBuilds(root);

      expect(mockSelect.mock.calls[0]?.[0].message).toBe('Choose a Pages scaffold toolchain:');
      expect(mockSelect.mock.calls[0]?.[0].initialValue).toBe('vite-plus');
      expect(mockSelect.mock.calls[1]?.[0].message).toBe('Choose a Pages framework to scaffold:');
      expect(mockSelect.mock.calls[2]?.[0].message).toBe('Choose a Pages starter:');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('offers to scaffold in a subfolder from a non-project parent directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      mkdirSync(join(root, 'existing-project'));
      mockSelect
        .mockResolvedValueOnce('subfolder')
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('static');
      mockText.mockResolvedValueOnce('my-new-app');
      mockConfirm.mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(existsSync(join(root, 'package.json'))).toBe(false);
      expect(existsSync(join(root, 'vite.config.ts'))).toBe(false);

      const appRoot = join(root, 'my-new-app');
      const pkg = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf-8'));
      expect(pkg.devDependencies['vite-plus']).toBe('^0.1.21');
      expect(pkg.scripts.dev).toBe('vp dev');
      expect(readFileSync(join(appRoot, 'pages', 'index.tsx'), 'utf-8')).toContain(
        'no database or server code yet',
      );

      const locationPrompt = mockSelect.mock.calls[0]?.[0];
      expect(locationPrompt.message).toBe(
        'This folder is not empty. Where should Void initialize?',
      );
      expect(locationPrompt.initialValue).toBe('subfolder');
      expect(mockText).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'New project folder name:',
          placeholder: 'my-void-app',
          defaultValue: 'my-void-app',
        }),
      );
      const folderPrompt = mockText.mock.calls[0]![0];
      expect(folderPrompt).not.toHaveProperty('initialValue');
      expect(folderPrompt.validate('')).toBeUndefined();
      expect(folderPrompt.validate(' ')).toBe('Enter a folder name.');
      mkdirSync(join(root, 'my-void-app'));
      expect(folderPrompt.validate('')).toBe('That folder already exists.');
      expect(folderPrompt.validate('another-app')).toBeUndefined();
      expect(mockSpawnSync).toHaveBeenCalledWith(
        'pnpm',
        ['install', '--no-frozen-lockfile'],
        expect.objectContaining({
          cwd: toSlash(appRoot),
          stdio: 'inherit',
          shell: process.platform === 'win32',
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('can continue configuring a non-project parent directory when requested', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      mkdirSync(join(root, 'existing-project'));
      mockSelect.mockResolvedValueOnce('current').mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(pkg.type).toBe('module');
      expect(pkg.devDependencies.void).toBeDefined();
      expect(pkg.scripts.dev).toBe('vite');
      expect(existsSync(join(root, 'vite.config.ts'))).toBe(true);
      expect(mockText).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('configures an existing package without forcing it to ESM', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'existing-app', private: true }, null, 2) + '\n',
      );
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(pkg.type).toBeUndefined();
      expect(pkg.scripts.dev).toBe('vite');
      expect(pkg.scripts.build).toBe('vite build');
      expect(pkg.devDependencies.void).toBeDefined();
      expect(pkg.devDependencies.vite).toBe('^8.0.10');

      expect(existsSync(join(root, 'vite.config.ts'))).toBe(false);
      const viteConfig = readFileSync(join(root, 'vite.config.mts'), 'utf-8');
      expect(viteConfig).toContain('import { voidPlugin } from "void";');
      expect(viteConfig).toContain('plugins: [voidPlugin()]');
      expect(mockConfirm).toHaveBeenCalledWith({
        message: 'Create .github/workflows/void-deploy.yml to deploy on pushes to main?',
      });
      expect(mockSpawnSync).toHaveBeenCalledWith(
        'npm',
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

  it('scaffolds an OIDC deploy workflow with a VOID_PROJECT placeholder when no project is linked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'existing-app', private: true }, null, 2) + '\n',
      );

      await runInitCommand(root, { github: true, tsconfig: false });

      const yaml = readFileSync(join(root, '.github', 'workflows', 'void-deploy.yml'), 'utf-8');
      // OIDC, not a stored secret.
      expect(yaml).not.toContain('secrets.VOID_TOKEN');
      // `id-token: write` is retained — `void deploy` mints the OIDC token.
      expect(yaml).toContain('id-token: write');
      expect(yaml).toContain('contents: read');
      // No linked project → placeholder repository variable.
      expect(yaml).toContain('VOID_PROJECT: ${{ vars.VOID_PROJECT }}');
      expect(yaml).toContain("VOID_API_URL: ${{ vars.VOID_API_URL || 'https://api.void.cloud' }}");
      // npm project → npx runner, deploy passes the project slug (the only step
      // that runs void).
      expect(yaml).toContain('npx void deploy --platform void --project "$VOID_PROJECT"');
      expect(yaml.match(/deploy --platform void --project "\$VOID_PROJECT"/g)).toHaveLength(1);
      // Latest-push-wins concurrency keyed by repo + ref (no env context, which
      // is unavailable to workflow-level concurrency).
      expect(yaml).toContain('concurrency:');
      expect(yaml).toContain('group: void-deploy-${{ github.repository }}-${{ github.ref }}');
      expect(yaml).toContain('cancel-in-progress: true');
      expect(mockNote).toHaveBeenCalledWith(
        expect.stringContaining('Set a VOID_PROJECT repository variable'),
        'GitHub Actions OIDC deploy',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bakes the linked project slug into the OIDC deploy workflow', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'existing-app', private: true }, null, 2) + '\n',
      );
      mkdirSync(join(root, '.void'), { recursive: true });
      writeFileSync(
        join(root, '.void', 'project.json'),
        JSON.stringify({ projectId: 'prj_123', slug: 'my-app' }, null, 2) + '\n',
      );

      await runInitCommand(root, { github: true, tsconfig: false });

      const yaml = readFileSync(join(root, '.github', 'workflows', 'void-deploy.yml'), 'utf-8');
      expect(yaml).toContain('VOID_PROJECT: my-app');
      expect(yaml).not.toContain('vars.VOID_PROJECT');
      // Latest-push-wins concurrency keyed by repo + ref (no env context, which
      // is unavailable to workflow-level concurrency).
      expect(yaml).toContain('concurrency:');
      expect(yaml).toContain('group: void-deploy-${{ github.repository }}-${{ github.ref }}');
      expect(yaml).toContain('cancel-in-progress: true');
      expect(mockNote).toHaveBeenCalledWith(
        expect.stringContaining('"my-app"'),
        'GitHub Actions OIDC deploy',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bakes the slug into void-deploy.yml when a project is linked during the same interactive init', async () => {
    // Step 8 (GitHub Actions) runs before Step 9 (project link), so the workflow
    // is first written with the `${{ vars.VOID_PROJECT }}` placeholder. After the
    // interactive link resolves a slug it must be patched into the workflow.
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'existing-astro-app',
            private: true,
            dependencies: { astro: '^5.0.0' },
          },
          null,
          2,
        ) + '\n',
      );
      mockGetToken.mockReturnValue('existing_token');
      mockListProjects.mockResolvedValueOnce([
        {
          id: 'proj_789',
          user_id: 'user_1',
          slug: 'linked-app',
          type: 'worker',
          created_at: '2026-03-27T00:00:00.000Z',
          custom_domain: null,
        },
      ]);
      // database → none, then the project-selection prompt → proj_789.
      mockSelect
        .mockResolvedValueOnce('none')
        .mockResolvedValueOnce('void')
        .mockResolvedValueOnce('proj_789');
      // GitHub Actions confirm → true; deploy-setup link confirm → true;
      // overwrite-existing-project confirm → true.
      mockConfirm
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);

      await runInitCommand(root);

      // The link was written...
      expect(JSON.parse(readFileSync(join(root, '.void', 'project.json'), 'utf-8'))).toEqual({
        applicationDomain: 'void.app',
        platform: 'void',
        platformUrl: 'https://api.void.cloud',
        proxyUrl: 'https://proxy.void.cloud',
        projectId: 'proj_789',
        slug: 'linked-app',
      });
      // ...and the workflow has the resolved slug, not the placeholder.
      const yaml = readFileSync(join(root, '.github', 'workflows', 'void-deploy.yml'), 'utf-8');
      expect(yaml).toContain('VOID_PROJECT: linked-app');
      expect(yaml).not.toContain('vars.VOID_PROJECT');
      expect(yaml).not.toContain('Set a VOID_PROJECT repository variable');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes void-deploy.yml and never touches an existing deploy.yml (no migration)', async () => {
    // `void init --github` does not migrate, rename, or delete any pre-existing
    // `.github/workflows/deploy.yml` — it only writes `void-deploy.yml`.
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'existing-app', private: true }, null, 2) + '\n',
      );
      mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
      const existingPath = join(root, '.github', 'workflows', 'deploy.yml');
      const existing = `name: CI
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm test
`;
      writeFileSync(existingPath, existing);

      await runInitCommand(root, { github: true, tsconfig: false });

      // The pre-existing workflow is preserved byte-for-byte...
      expect(existsSync(existingPath)).toBe(true);
      expect(readFileSync(existingPath, 'utf-8')).toBe(existing);
      // ...and void-deploy.yml was written alongside it.
      const workflows = readdirSync(join(root, '.github', 'workflows')).sort();
      expect(workflows).toEqual(['deploy.yml', 'void-deploy.yml']);
      const oidc = readFileSync(join(root, '.github', 'workflows', 'void-deploy.yml'), 'utf-8');
      expect(oidc).toContain('name: Deploy to Void');
      expect(oidc).toContain('npx void deploy --platform void --project "$VOID_PROJECT"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('configures an existing class-C framework without plain Vite package setup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'existing-astro-app',
            private: true,
            dependencies: {
              astro: '^5.0.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(pkg.scripts).toBeUndefined();
      expect(pkg.devDependencies.void).toBeDefined();
      expect(pkg.devDependencies.vite).toBeUndefined();
      expect(existsSync(join(root, 'vite.config.ts'))).toBe(false);
      expect(mockNote).toHaveBeenCalledWith(
        expect.stringContaining('Add `voidPlugin()` to the Astro Vite plugins option'),
        'Manual Astro config step',
      );
      expect(mockNote).toHaveBeenCalledWith(
        expect.stringContaining('vite: { plugins: [voidPlugin()] }'),
        'Manual Astro config step',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prints a Nuxt-specific manual config step for existing Nuxt projects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'existing-nuxt-app',
            private: true,
            dependencies: {
              nuxt: '^4.0.0',
              void: '^0.6.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(existsSync(join(root, 'vite.config.ts'))).toBe(false);
      expect(mockNote).toHaveBeenCalledWith(
        expect.stringContaining('Add `voidPlugin()` to the Nuxt Vite plugins option'),
        'Manual Nuxt config step',
      );
      expect(mockNote).toHaveBeenCalledWith(
        expect.stringContaining('export default defineNuxtConfig'),
        'Manual Nuxt config step',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('adds voidPlugin to an existing Vite plugins array without replacing scripts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'vite-app',
            scripts: {
              dev: 'custom-dev',
              test: 'vitest',
            },
            devDependencies: {
              vite: '^8.0.10',
              void: '^0.6.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(
        join(root, 'vite.config.ts'),
        `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    react(),
  ],
});
`,
      );
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(pkg.type).toBeUndefined();
      expect(pkg.scripts.dev).toBe('custom-dev');
      expect(pkg.scripts.build).toBe('vite build');
      expect(pkg.scripts.test).toBe('vitest');

      const viteConfig = readFileSync(join(root, 'vite.config.ts'), 'utf-8');
      expect(viteConfig).toContain('import { voidPlugin } from "void";');
      expect(viteConfig).toContain(`plugins: [
    voidPlugin(),
    react(),`);
      expect(mockSpawnSync).toHaveBeenCalledWith(
        'npm',
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

  it('patches only the top-level Vite plugins array', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'nested-vite-plugins-app',
            devDependencies: {
              vite: '^8.0.10',
              void: '^0.6.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(
        join(root, 'vite.config.ts'),
        `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import legacy from "@vitejs/plugin-legacy";

export default defineConfig({
  build: {
    rollupOptions: {
      plugins: [legacy()],
    },
  },
  plugins: [
    react(),
  ],
});
`,
      );
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const viteConfig = readFileSync(join(root, 'vite.config.ts'), 'utf-8');
      expect(viteConfig).toContain(`rollupOptions: {
      plugins: [legacy()],
    },`);
      expect(viteConfig).toContain(`plugins: [
    voidPlugin(),
    react(),`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('adds a top-level Vite plugins property instead of patching nested plugin options', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'nested-vite-no-top-level-plugins-app',
            devDependencies: {
              vite: '^8.0.10',
              void: '^0.6.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(
        join(root, 'vite.config.ts'),
        `import { defineConfig } from "vite";
import legacy from "@vitejs/plugin-legacy";

export default defineConfig({
  build: {
    rollupOptions: {
      plugins: [legacy()],
    },
  },
});
`,
      );
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const viteConfig = readFileSync(join(root, 'vite.config.ts'), 'utf-8');
      expect(viteConfig).toContain(`export default defineConfig({
  plugins: [voidPlugin()],
  build: {`);
      expect(viteConfig).toContain(`rollupOptions: {
      plugins: [legacy()],
    },`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prints a manual Vite config step when an existing config is too dynamic to patch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'dynamic-vite-app',
            devDependencies: {
              vite: '^8.0.10',
              void: '^0.6.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(
        join(root, 'vite.config.ts'),
        `const config = buildConfig();

export default config;
`,
      );
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(readFileSync(join(root, 'vite.config.ts'), 'utf-8'))
        .toBe(`const config = buildConfig();

export default config;
`);
      expect(mockNote).toHaveBeenCalledWith(
        expect.stringContaining('Could not safely update vite.config.ts automatically'),
        'Manual Vite config step',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not patch nested plugin arrays when the top-level Vite config object is dynamic', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'dynamic-nested-vite-app',
            devDependencies: {
              vite: '^8.0.10',
              void: '^0.6.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(
        join(root, 'vite.config.ts'),
        `const config = {
  build: {
    rollupOptions: {
      plugins: [legacy()],
    },
  },
};

export default config;
`,
      );
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(readFileSync(join(root, 'vite.config.ts'), 'utf-8')).toBe(`const config = {
  build: {
    rollupOptions: {
      plugins: [legacy()],
    },
  },
};

export default config;
`);
      expect(mockNote).toHaveBeenCalledWith(
        expect.stringContaining('Add `voidPlugin()` to the top-level Vite plugins array'),
        'Manual Vite config step',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not run existing-project setup for targeted init flags', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'targeted-app' }, null, 2) + '\n',
      );

      await runInitCommand(root, { tsconfig: true, github: false });

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(pkg.scripts).toBeUndefined();
      expect(pkg.devDependencies).toBeUndefined();
      expect(existsSync(join(root, 'vite.config.ts'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe('coding agent setup', () => {
    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    let previousCI: string | undefined;

    beforeEach(() => {
      previousCI = process.env.CI;
      delete process.env.CI;
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, get: () => true });
    });

    afterEach(() => {
      if (previousCI === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = previousCI;
      }
      if (ttyDescriptor) {
        Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
      } else {
        Reflect.deleteProperty(process.stdin, 'isTTY');
      }
    });

    it('creates minimal AGENTS.md for a new project without prompting or agent detection', async () => {
      const root = mkdtempSync(join(tmpdir(), 'void-init-'));
      try {
        await runInitCommand(root, { tsconfig: true, github: false });

        const instructions = readFileSync(join(root, 'AGENTS.md'), 'utf-8');
        expect(instructions).toContain('## Void');
        expect(instructions).toContain('node_modules/void/docs/');
        expect(instructions.match(/^- /gm)).toHaveLength(2);
        expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
        expect(mockSelect).not.toHaveBeenCalled();
        expect(mockConfirm).not.toHaveBeenCalled();

        await runInitCommand(root, { tsconfig: true, github: false });
        expect(readFileSync(join(root, 'AGENTS.md'), 'utf-8')).toBe(instructions);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it.each([false, true])(
      'writes AGENTS.md and preserves CLAUDE.md when Claude is detected (existing AGENTS.md: %s)',
      async (hasAgentsFile) => {
        // Resolve macOS's /var alias so relative skill symlinks use the fixture's real path.
        const root = realpathSync(mkdtempSync(join(tmpdir(), 'void-init-')));
        try {
          const claudeInstructions = '# Claude instructions\n\nKeep these instructions.\n';
          const projectInstructions = '# Project instructions\n\nKeep this guidance.\n';
          writeFileSync(join(root, 'CLAUDE.md'), claudeInstructions);
          mkdirSync(join(root, '.claude'));
          mkdirSync(join(root, 'src'));
          if (hasAgentsFile) {
            writeFileSync(join(root, 'AGENTS.md'), projectInstructions);
          }
          mockConfirm.mockResolvedValueOnce(true);

          await runInitCommand(root, { tsconfig: true, github: false });

          const instructions = readFileSync(join(root, 'AGENTS.md'), 'utf-8');
          expect(instructions).toContain('## Void');
          if (hasAgentsFile) {
            expect(instructions.startsWith(projectInstructions)).toBe(true);
          }
          expect(readFileSync(join(root, 'CLAUDE.md'), 'utf-8')).toBe(claudeInstructions);
          expect(existsSync(join(root, '.claude/skills/void/SKILL.md'))).toBe(true);
          expect(mockSelect).not.toHaveBeenCalled();
          expect(mockConfirm).toHaveBeenCalledExactlyOnceWith({
            message: hasAgentsFile
              ? 'Append Void instructions to AGENTS.md?'
              : 'Create AGENTS.md with Void instructions?',
            initialValue: true,
          });
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    );

    it.each(['prerelease', 'current'])(
      'updates %s agent instructions only after approval',
      async (versionKind) => {
        const root = mkdtempSync(join(tmpdir(), 'void-init-'));
        try {
          const currentVersion = JSON.parse(
            readFileSync(join(process.cwd(), 'packages/void/package.json'), 'utf-8'),
          ).version;
          const before = '# Project guidance\n\nKeep this user-authored introduction.\n\n';
          const after = '\n\nKeep this user-authored footer.\n';
          const oldVersion = versionKind === 'current' ? currentVersion : '1.2.3-beta.2+build.7';
          writeFileSync(
            join(root, 'AGENTS.md'),
            `${before}<!--injected-by-void-v${oldVersion}-->\nStale managed instructions.\n<!--/injected-by-void-->${after}`,
          );
          mockConfirm.mockResolvedValueOnce(true);

          await runInitCommand(root, { tsconfig: true, github: false });

          const updated = readFileSync(join(root, 'AGENTS.md'), 'utf-8');
          expect(updated.startsWith(before)).toBe(true);
          expect(updated.endsWith(after)).toBe(true);
          expect(updated).toContain(`<!--injected-by-void-v${currentVersion}-->`);
          expect(updated).not.toContain('1.2.3-beta.2+build.7');
          expect(updated).not.toContain('Stale managed instructions.');
          expect(updated).toContain('node_modules/void/docs/');
          expect(updated.match(/<!--injected-by-void-v/g)).toHaveLength(1);
          expect(updated.match(/<!--\/injected-by-void-->/g)).toHaveLength(1);
          expect(mockConfirm).toHaveBeenCalledExactlyOnceWith({
            message: 'Update Void instructions in AGENTS.md?',
            initialValue: true,
          });
          await runInitCommand(root, { tsconfig: true, github: false });
          expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(updated);
          expect(mockConfirm).toHaveBeenCalledTimes(1);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    );

    it.each([false, true])(
      'preserves existing project instructions when declined (AGENTS.md: %s)',
      async (hasInstructions) => {
        const root = mkdtempSync(join(tmpdir(), 'void-init-agents-decline-'));
        const original = '# My project\n\nKeep this unchanged.\n';
        try {
          mkdirSync(join(root, 'src'));
          if (hasInstructions) {
            writeFileSync(join(root, 'AGENTS.md'), original);
          }
          mockConfirm.mockResolvedValueOnce(false);
          await runInitCommand(root, { tsconfig: true, github: false });
          expect(mockConfirm).toHaveBeenCalledTimes(1);
          if (hasInstructions) {
            expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(original);
          } else {
            expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
          }
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    );

    it.each(['CI', 'non-TTY'])('does not change existing AGENTS.md in %s', async (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'void-init-agents-headless-'));
      const original = '# Keep my instructions\n';
      try {
        writeFileSync(join(root, 'AGENTS.md'), original);
        if (mode === 'CI') {
          process.env.CI = 'true';
        } else {
          Object.defineProperty(process.stdin, 'isTTY', { configurable: true, get: () => false });
        }
        await runInitCommand(root, { tsconfig: true, github: false });
        expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(original);
        expect(mockConfirm).not.toHaveBeenCalled();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('cancels before appending instructions', async () => {
      const root = mkdtempSync(join(tmpdir(), 'void-init-agents-cancel-'));
      const original = '# Keep my instructions\n';
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('Cancelled');
      });
      try {
        writeFileSync(join(root, 'AGENTS.md'), original);
        mockConfirm.mockResolvedValueOnce(Symbol.for('cancel'));
        await expect(runInitCommand(root, { tsconfig: true, github: false })).rejects.toThrow(
          'Cancelled',
        );
        expect(exit).toHaveBeenCalledWith(0);
        expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(original);
      } finally {
        exit.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it('creates .gitignore with Void defaults during targeted setup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      await runInitCommand(root, { tsconfig: true, github: false });

      const gitignore = readFileSync(join(root, '.gitignore'), 'utf-8');
      expect(gitignore).toContain('node_modules');
      expect(gitignore).toContain('.void');
      expect(gitignore).toContain('.wrangler');
      expect(gitignore).toContain('.env');
      expect(gitignore.split('\n')).toContain('.env.*');
      expect(gitignore.split('\n')).toContain('!.env.example');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('appends missing Void defaults to an existing .gitignore', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(root, '.gitignore'), 'node_modules\ncustom-cache\n');

      await runInitCommand(root, { tsconfig: true, github: false });

      const gitignore = readFileSync(join(root, '.gitignore'), 'utf-8');
      expect(gitignore).toContain('custom-cache');
      expect(gitignore).toContain('.void');
      expect(gitignore).toContain('.wrangler');
      expect(gitignore).toContain('.env');
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

      await runInitCommand(root, { tsconfig: true, github: false });

      const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf-8'));
      expect(tsconfig.extends).toBeDefined();
      expect(tsconfig.compilerOptions.types).toContain('void/env');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('merges Void type files and path aliases into root-level tsconfig fields', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      mkdirSync(join(root, 'routes'), { recursive: true });
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'main.ts'), 'export {};\n');
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify(
          {
            extends: './tsconfig.base.json',
            compilerOptions: {
              paths: {
                '@/*': ['src/*'],
              },
            },
            files: ['src/main.ts'],
            include: ['src', 'routes'],
          },
          null,
          2,
        ) + '\n',
      );

      await runInitCommand(root, { tsconfig: true, github: false });

      const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf-8'));
      expect(tsconfig.extends).toEqual(['./tsconfig.base.json', './.void/tsconfig.json']);
      expect(tsconfig.files).toEqual(['./src/main.ts', './.void/routes.d.ts']);
      expect(tsconfig.compilerOptions.paths).toEqual({
        '@/*': ['./src/*'],
        'void/routes': ['./.void/routes.d.ts'],
      });
      expect(tsconfig.compilerOptions.types).toContain('void/env');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves directly extended tsconfig files and paths when adding Void config', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      mkdirSync(join(root, 'routes'), { recursive: true });
      writeFileSync(join(root, 'base.d.ts'), 'declare const baseValue: string;\n');
      writeFileSync(
        join(root, 'tsconfig.base.json'),
        JSON.stringify(
          {
            compilerOptions: {
              paths: {
                '~/*': ['./src/*'],
              },
            },
            files: ['base.d.ts'],
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify(
          {
            extends: ['./tsconfig.base.json'],
            include: ['src', 'routes'],
          },
          null,
          2,
        ) + '\n',
      );

      await runInitCommand(root, { tsconfig: true, github: false });

      const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf-8'));
      expect(tsconfig.extends).toEqual(['./tsconfig.base.json', './.void/tsconfig.json']);
      expect(tsconfig.files).toEqual(['./base.d.ts', './.void/routes.d.ts']);
      expect(tsconfig.compilerOptions.paths).toEqual({
        '~/*': ['./src/*'],
        'void/routes': ['./.void/routes.d.ts'],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes Void path aliases relative to an inherited baseUrl', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      const root = join(workspaceRoot, 'packages', 'app');
      mkdirSync(join(root, 'routes'), { recursive: true });
      writeFileSync(
        join(workspaceRoot, 'tsconfig.base.json'),
        JSON.stringify(
          {
            compilerOptions: {
              baseUrl: '.',
              paths: {
                '@shared/*': ['shared/*'],
              },
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify(
          {
            extends: '../../tsconfig.base.json',
            include: ['src', 'routes'],
          },
          null,
          2,
        ) + '\n',
      );

      await runInitCommand(root, { tsconfig: true, github: false });

      const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf-8'));
      expect(tsconfig.extends).toEqual(['../../tsconfig.base.json', './.void/tsconfig.json']);
      expect(tsconfig.compilerOptions.paths).toEqual({
        '@shared/*': ['./shared/*'],
        'void/routes': ['./packages/app/.void/routes.d.ts'],
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('merges Void type files and paths into explicit empty tsconfig override fields', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      mkdirSync(join(root, 'routes'), { recursive: true });
      writeFileSync(join(root, 'base.d.ts'), 'declare const baseValue: string;\n');
      writeFileSync(
        join(root, 'tsconfig.base.json'),
        JSON.stringify(
          {
            compilerOptions: {
              paths: {
                '~/*': ['./src/*'],
              },
            },
            files: ['base.d.ts'],
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify(
          {
            extends: './tsconfig.base.json',
            compilerOptions: {
              paths: {},
            },
            files: [],
            include: ['src', 'routes'],
          },
          null,
          2,
        ) + '\n',
      );

      await runInitCommand(root, { tsconfig: true, github: false });

      const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf-8'));
      expect(tsconfig.extends).toEqual(['./tsconfig.base.json', './.void/tsconfig.json']);
      expect(tsconfig.files).toEqual(['./.void/routes.d.ts']);
      expect(tsconfig.compilerOptions.paths).toEqual({
        'void/routes': ['./.void/routes.d.ts'],
      });
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
              void: '^0.2.3',
              '@void/react': '^0.2.3',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");

      mockSelect.mockResolvedValueOnce('vite-plus').mockResolvedValueOnce('sqlite');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(pkg.scripts.dev).toBe('vp dev');
      expect(pkg.devDependencies['vite-plus']).toBe('^0.1.21');
      expect(pkg.devDependencies.void).toBe('^0.2.3');
      expect(pkg.devDependencies['@void/react']).toBe('^0.2.3');
      expect(pkg.devDependencies['oxc-transform-react']).toBe('^0.149.0');
      expectPnpmAllowBuilds(root);

      const reactViteConfig = readFileSync(join(root, 'vite.config.ts'), 'utf-8');
      expect(reactViteConfig).toContain('from "@void/react/plugin"');
      expect(reactViteConfig).toContain('voidReact({ react: { compiler: true } })');

      expect(mockSelect.mock.calls[0]?.[0].message).toBe('Choose a Pages scaffold toolchain:');
      expect(mockSelect.mock.calls[0]?.[0].initialValue).toBe('vite-plus');
      expect(mockSelect.mock.calls[1]?.[0].message).toBe('Choose a Pages starter:');
      expect(mockSelect).not.toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Choose a Pages framework to scaffold:' }),
      );
      expect(mockSpawnSync).toHaveBeenCalledWith(
        'pnpm',
        ['install', '--no-frozen-lockfile'],
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
      mockSelect.mockResolvedValueOnce('sqlite');
      mockConfirm
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(readConfig(root)).toEqual({
        worker: {
          compatibility_date: LATEST_KNOWN_COMPAT_DATE,
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
      mockSelect.mockResolvedValueOnce('sqlite');
      mockConfirm
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(readConfig(root)).toEqual({
        routing: {
          prerender: ['/'],
        },
        worker: {
          compatibility_date: LATEST_KNOWN_COMPAT_DATE,
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
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(readConfig(root)).toEqual({
        worker: {
          compatibility_date: LATEST_KNOWN_COMPAT_DATE,
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
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('sqlite')
        .mockResolvedValueOnce('void')
        .mockResolvedValueOnce('github');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      mockText.mockResolvedValueOnce('my-live-app');
      mockCreateProject.mockResolvedValueOnce({ id: 'proj_live', slug: 'my-live-app' });

      await runInitCommand(root);

      expect(mockConfirm.mock.calls[1]?.[0]).toMatchObject({
        message: 'Log in now and link or create a Void project?',
      });
      expect(mockRunLogin).toHaveBeenCalledWith(
        'https://api.void.cloud',
        'github',
        expect.any(Function),
      );
      expect(mockSaveToken).toHaveBeenCalledWith('token_123', 'https://api.void.cloud');
      expect(mockListProjects).toHaveBeenCalledOnce();
      expect(mockCreateProject).toHaveBeenCalledWith('my-live-app');
      expect(JSON.parse(readFileSync(join(root, '.void', 'project.json'), 'utf-8'))).toEqual({
        applicationDomain: 'void.app',
        platform: 'void',
        platformUrl: 'https://api.void.cloud',
        proxyUrl: 'https://proxy.void.cloud',
        projectId: 'proj_live',
        slug: 'my-live-app',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('installs starter dependencies before optional project creation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      mockSelect
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('sqlite')
        .mockResolvedValueOnce('void')
        .mockResolvedValueOnce('github');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      mockText.mockResolvedValueOnce('my-live-app');
      mockCreateProject.mockRejectedValueOnce(new Error('project create failed'));

      await expect(runInitCommand(root)).rejects.toThrow('project create failed');

      const installCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][0] === 'install',
      );
      expect(installCalls.length).toBeGreaterThan(0);

      const drizzleCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][1] === 'generate',
      );
      expect(drizzleCalls.length).toBeGreaterThan(0);
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
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('sqlite')
        .mockResolvedValueOnce('void')
        .mockResolvedValueOnce('proj_456');
      mockConfirm
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);

      await runInitCommand(root);

      expect(mockConfirm.mock.calls[1]?.[0]).toMatchObject({
        message: 'Link your Void project now?',
      });
      expect(mockConfirm.mock.calls[2]?.[0]).toMatchObject({
        message:
          'Linking to an existing project. Running `void deploy` will overwrite the current deployment of existing-app.void.app. Continue?',
      });
      expect(mockRunLogin).not.toHaveBeenCalled();
      expect(mockSaveToken).not.toHaveBeenCalled();
      expect(mockCreateProject).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(join(root, '.void', 'project.json'), 'utf-8'))).toEqual({
        applicationDomain: 'void.app',
        platform: 'void',
        platformUrl: 'https://api.void.cloud',
        proxyUrl: 'https://proxy.void.cloud',
        projectId: 'proj_456',
        slug: 'existing-app',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('defaults deployment setup to Cloudflare, opens login, and offers its GitHub workflow', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeExistingAstroProject(root);
      selectCloudflareDuringInit();
      mockSpawnSync.mockImplementation((_command, args) =>
        cloudflareOperationType(args) === 'auth.whoami'
          ? { status: 1, stdout: '', stderr: 'Not authenticated' }
          : { status: 0, stdout: '', stderr: '' },
      );
      mockConfirm.mockImplementation((options: { message?: string }) => {
        if (
          options.message ===
          'Create .github/workflows/void-deploy.yml to deploy on pushes to main?'
        ) {
          return true;
        }
        return undefined;
      });

      await runInitCommand(root);

      const platformPrompt = mockSelect.mock.calls.find(
        ([options]) => options.message === 'Where should this project deploy?',
      )?.[0];
      expect(platformPrompt).toMatchObject({ initialValue: 'cloudflare' });
      expect(JSON.parse(readFileSync(join(root, '.void', 'project.json'), 'utf-8'))).toEqual({
        platform: 'cloudflare',
      });
      expect(JSON.parse(readFileSync(join(root, '.void-wrangler.jsonc'), 'utf-8'))).toEqual({
        compatibility_date: LATEST_KNOWN_COMPAT_DATE,
        compatibility_flags: ['nodejs_als'],
      });
      expect(mockSpawnSync).toHaveBeenCalledWith(
        process.execPath,
        expect.arrayContaining([
          JSON.stringify({
            type: 'auth.whoami',
            configPath: toSlash(join(root, '.void-wrangler.jsonc')),
          }),
        ]),
        expect.objectContaining({ cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }),
      );
      expect(mockSpawnSync).toHaveBeenCalledWith(
        process.execPath,
        expect.arrayContaining([JSON.stringify({ type: 'auth.login' })]),
        expect.objectContaining({ cwd: root, stdio: 'inherit' }),
      );
      expect(mockNote).toHaveBeenCalledWith(
        expect.stringContaining('Run `void connect --platform cloudflare`'),
        'Cloudflare deployment',
      );
      expect(mockGetToken).not.toHaveBeenCalled();
      expect(mockListProjects).not.toHaveBeenCalled();
      expect(
        readFileSync(join(root, '.github', 'workflows', 'void-deploy.yml'), 'utf-8'),
      ).toContain('void deploy --platform cloudflare');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stores the only authenticated Cloudflare account and preserves Wrangler JSONC', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeExistingAstroProject(root);
      writeFileSync(
        join(root, 'wrangler.jsonc'),
        '{\n  // Keep this comment.\n  "name": "existing-worker",\n  "vars": { "EXAMPLE": "yes" }\n}\n',
      );
      selectCloudflareDuringInit();
      mockSpawnSync.mockImplementation((_command, args) =>
        cloudflareOperationType(args) === 'auth.whoami'
          ? wranglerWhoamiResult([{ id: 'account-1', name: 'My account' }])
          : { status: 0, stdout: '', stderr: '' },
      );

      await runInitCommand(root);

      const wrangler = readFileSync(join(root, '.void-wrangler.jsonc'), 'utf-8');
      expect(existsSync(join(root, 'wrangler.jsonc'))).toBe(false);
      expect(readConfig(root).cloudflare?.name).toBe('existing-worker');
      expect(wrangler).toContain('// Keep this comment.');
      expect(wrangler).toContain('"name": "existing-worker"');
      expect(wrangler).toContain('"EXAMPLE": "yes"');
      expect(wrangler).toContain('"compatibility_date":');
      expect(wrangler).toContain('"account_id": "account-1"');
      expect(mockSpawnSync).not.toHaveBeenCalledWith(
        process.execPath,
        expect.arrayContaining([JSON.stringify({ type: 'auth.login' })]),
        expect.anything(),
      );
      expect(mockSelect).not.toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Choose a Cloudflare account:' }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('opens Cloudflare browser login, rereads accounts, and stores the selected account', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeExistingAstroProject(root);
      selectCloudflareDuringInit('account-2');
      let whoamiCalls = 0;
      mockSpawnSync.mockImplementation((_command, args) => {
        if (cloudflareOperationType(args) === 'auth.whoami') {
          whoamiCalls++;
          return whoamiCalls === 1
            ? { status: 1, stdout: '', stderr: 'Not authenticated' }
            : wranglerWhoamiResult([
                { id: 'account-1', name: 'First account' },
                { id: 'account-2', name: 'Second account' },
              ]);
        }
        return { status: 0, stdout: '', stderr: '' };
      });

      await runInitCommand(root);

      expect(whoamiCalls).toBe(2);
      expect(mockSpawnSync).toHaveBeenCalledWith(
        process.execPath,
        expect.arrayContaining([JSON.stringify({ type: 'auth.login' })]),
        expect.objectContaining({ cwd: root, stdio: 'inherit' }),
      );
      const accountPrompt = mockSelect.mock.calls.find(
        ([options]) => options.message === 'Choose a Cloudflare account:',
      )?.[0];
      expect(accountPrompt).toMatchObject({ initialValue: 'account-1' });
      expect(accountPrompt.options).toEqual([
        { value: 'account-1', label: 'First account', hint: 'account-1' },
        { value: 'account-2', label: 'Second account', hint: 'account-2' },
      ]);
      expect(readFileSync(join(root, '.void-wrangler.jsonc'), 'utf-8')).toContain(
        '"account_id": "account-2"',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps an existing valid Cloudflare account without asking again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeExistingAstroProject(root);
      writeFileSync(
        join(root, 'wrangler.jsonc'),
        JSON.stringify(
          { compatibility_date: '2026-01-02', account_id: 'account-2', name: 'my-worker' },
          null,
          2,
        ) + '\n',
      );
      selectCloudflareDuringInit('account-1');
      mockSpawnSync.mockImplementation((_command, args) =>
        cloudflareOperationType(args) === 'auth.whoami'
          ? wranglerWhoamiResult([
              { id: 'account-1', name: 'First account' },
              { id: 'account-2', name: 'Second account' },
            ])
          : { status: 0, stdout: '', stderr: '' },
      );

      await runInitCommand(root);

      expect(mockSelect).not.toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Choose a Cloudflare account:' }),
      );
      expect(JSON.parse(readFileSync(join(root, '.void-wrangler.jsonc'), 'utf-8'))).toEqual({
        compatibility_date: '2026-01-02',
        account_id: 'account-2',
        name: 'my-worker',
        compatibility_flags: ['nodejs_als'],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('continues without an account when Cloudflare sign-in fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeExistingAstroProject(root);
      selectCloudflareDuringInit();
      mockSpawnSync.mockImplementation((_command, args) =>
        cloudflareOperationType(args) === 'auth.login'
          ? { status: 1, stdout: '', stderr: 'Login failed' }
          : cloudflareOperationType(args) === 'auth.whoami'
            ? { status: 1, stdout: '', stderr: 'Not authenticated' }
            : { status: 0, stdout: '', stderr: '' },
      );

      await runInitCommand(root);

      expect(JSON.parse(readFileSync(join(root, '.void-wrangler.jsonc'), 'utf-8'))).toEqual({
        compatibility_date: LATEST_KNOWN_COMPAT_DATE,
        compatibility_flags: ['nodejs_als'],
      });
      expect(
        mockSpawnSync.mock.calls.filter(
          ([, args]) => cloudflareOperationType(args) === 'auth.whoami',
        ),
      ).toHaveLength(1);
      expect(mockLogWarn).toHaveBeenCalledWith(
        'Cloudflare browser sign-in did not complete. Run `void cloudflare login` to try again.',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists skipped deployment setup without prompting for Void setup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          { name: 'existing-astro-app', private: true, dependencies: { astro: '^5.0.0' } },
          null,
          2,
        ) + '\n',
      );
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('none');

      await runInitCommand(root);

      expect(JSON.parse(readFileSync(join(root, '.void', 'project.json'), 'utf-8'))).toEqual({
        platform: 'none',
      });
      expect(mockGetToken).not.toHaveBeenCalled();
      expect(mockListProjects).not.toHaveBeenCalled();
      expect(existsSync(join(root, '.github', 'workflows', 'void-deploy.yml'))).toBe(false);
      expect(
        mockSpawnSync.mock.calls.some(([, args]) =>
          ['auth.whoami', 'auth.login'].includes(cloudflareOperationType(args) ?? ''),
        ),
      ).toBe(false);
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
      mockSelect.mockResolvedValueOnce('none');
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
          value: 'mysql',
          label: 'MySQL',
          hint: 'Bring your own MySQL via Hyperdrive; ideal for existing MySQL infrastructure and compatible providers.',
        },
        {
          value: 'none',
          label: 'No Database Yet',
          hint: 'Skip database setup for now. You can add D1, PostgreSQL, or MySQL later as your app grows.',
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips install after demo scaffold when node_modules/void is already populated (workspace subpackage)', async () => {
    // Workspace subpackages with a `workspace:` spec and no lockfile
    // must not hit a spurious `npm install` that aborts on `workspace:`
    // ranges. `node_modules/void` is already populated here
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
      mockSelect.mockResolvedValueOnce('none');
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
    // Workspace subpackages typically don't have `void` in their own
    // `node_modules` — the package manager hoists it to the workspace
    // root. Node's module resolution walks up the directory tree, so
    // drizzle-kit can still `require('void/schema-d1')` from the
    // subpackage via the ancestor install. The hoisted case must count as
    // "already installed" so no spurious subpackage install runs.
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
      mockSelect.mockResolvedValueOnce('none');
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
    // The workspace skip branch requires an actual workspace marker
    // (`pnpm-workspace.yaml` or `package.json#workspaces`) AND declared
    // membership via `isWorkspaceSubpackage`. The setup below has
    // NEITHER — the parent is a plain directory with a hoisted
    // `node_modules/void`, not a workspace root.
    //
    // Skipping install for a nested non-workspace app would leave the
    // child's `package.json` disagreeing with any lockfile the child may
    // already have, and the next frozen-install fails the integrity check.
    // So install runs whenever we changed the child's `package.json`,
    // unless a workspace-subpackage branch already decided to skip.
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
      mockSelect.mockResolvedValueOnce('none');
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
    // A fresh clone of a monorepo (no lockfile anywhere, no
    // `node_modules` populated yet) running `void init` inside a workspace
    // subpackage finds no `node_modules/void`. Forcing an `npm install`
    // would abort on the subpackage's `workspace:` specs. Instead the
    // workspace-subpackage shape is detected via `findWorkspaceRoot`
    // (pnpm-workspace.yaml or parent `package.json` with a `workspaces`
    // field) and BOTH the install AND `generateStarterMigration` are
    // skipped — surfacing a `note()` that tells the user how to finish.
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
      mockSelect.mockResolvedValueOnce('none');
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
      const body = String(
        matching.find((call) => String(call[0]).includes('Scaffolded the starter demo'))?.[0] ?? '',
      );
      expect(body).toMatch(/Scaffolded the starter demo/);
      expect(body).toMatch(/void db generate/);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('skips install and starter migration in a fresh workspace subpackage (npm workspaces root)', async () => {
    // Symmetric case: workspace root marker is a parent
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
      mockSelect.mockResolvedValueOnce('none');
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
    // `scaffoldDemo` (via `ensureVoidDependency`) writes a new `void`
    // entry into the subpackage's `package.json` while `void` is already
    // resolvable via an ancestor `node_modules/void`. Without a note, the
    // workspace lockfile silently disagrees with `package.json` and the
    // next `pnpm install --frozen-lockfile` fails the integrity check.
    // The note points at the workspace root so the user re-runs their
    // workspace install; `generateStarterMigration` is still skipped,
    // matching the other workspace-subpackage branch.
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
      mockSelect.mockResolvedValueOnce('none');
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
    // `findWorkspaceRoot` only walks ancestors looking for a
    // `pnpm-workspace.yaml` / `package.json#workspaces` marker — it
    // doesn't verify that `root` is actually a declared member of that
    // workspace. A standalone scratch app at `<wsroot>/scratch/my-app`
    // under a workspace that only declares `packages/*` is NOT a
    // subpackage; treating it as one would skip the install and leave
    // unresolved `void` imports. Non-members fall through to the
    // fresh-clone install branch.
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
      mockSelect.mockResolvedValueOnce('none');
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
    // Symmetric case: workspace root marker is a parent
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
      mockSelect.mockResolvedValueOnce('none');
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
    // A fresh clone of a regular project that already declares `void` in
    // `package.json` but has no `node_modules` yet must still install, or
    // `generateStarterMigration` spawns drizzle-kit where
    // `void/schema-d1` can't resolve. Install is forced when
    // `node_modules/void/package.json` is absent.
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
      mockSelect.mockResolvedValueOnce('none');
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
    // `generateStarterMigration()` injects the PnP loaders into the
    // spawned child's `NODE_OPTIONS` via `buildDrizzleKitSpawnEnv`,
    // matching what `gen.ts:runMigration` does — so `drizzle-kit
    // generate` resolves `void/schema-d1` even when there is no
    // `node_modules` tree. The init flow completes the migration itself
    // instead of asking the user to run it manually.
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
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      // Normalize NODE_OPTIONS so assertions aren't contaminated by
      // the ambient vitest environment.
      const savedNodeOptions = process.env.NODE_OPTIONS;
      delete process.env.NODE_OPTIONS;

      // Simulate `yarn install` writing `.pnp.cjs` AND the post-install
      // marker `.yarn/install-state.gz` as its side effect.
      // `isVoidResolvableFrom` requires BOTH — a committed-but-unfetched
      // `.pnp.cjs` on a fresh clone is not proof that `yarn install` has
      // actually populated the archives.
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
      expect(spawnOptions.env!.NODE_OPTIONS).toContain(
        JSON.stringify(toSlash(join(root, '.pnp.cjs'))),
      );

      // No "Yarn PnP" skip note — the migration runs inline.
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
    // Yarn 3/4 projects configured with
    // `nodeLinker: node-modules` commit `.yarnrc.yml` and still produce
    // a normal `node_modules` tree. Those projects work fine with
    // `generateStarterMigration()` because drizzle-kit can resolve
    // `void/schema-d1` through standard Node module resolution.
    //
    // `.yarnrc.yml` alone is NOT a PnP marker; only the real
    // post-install markers `.pnp.cjs` / `.pnp.loader.mjs` count, which
    // exist iff PnP was the actual linker.
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
      mockSelect.mockResolvedValueOnce('none');
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
    // Yarn Classic (`yarn@1.22.x`) always uses the
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
      mockSelect.mockResolvedValueOnce('none');
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
    // A valid `pnpm-workspace.yaml` can declare the packages list inline
    // as
    //   packages: ['packages/*']
    // instead of the multiline block form. The subpackage-skip branch
    // must fire for both shapes; otherwise `void init` falls through to
    // the fresh-clone install path, which aborts on the subpackage's
    // `workspace:*` spec.
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
      mockSelect.mockResolvedValueOnce('none');
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
    // A real-world `pnpm-workspace.yaml` sometimes writes
    // `- './packages/*'` instead of `- 'packages/*'`. The leading `./`
    // must be stripped before segment splitting, or no subpackage path
    // matches and the fresh-clone install branch aborts on the
    // subpackage's `workspace:*` spec.
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
      mockSelect.mockResolvedValueOnce('none');
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
    // Real workspaces sometimes declare partial-segment globs like
    // `packages/*-app`, `packages/app-*`, or `apps/*-service`. Each
    // segment compiles to a regex so these match.
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
      mockSelect.mockResolvedValueOnce('none');
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
    // Negative case: a workspace that declares `packages/*-app`
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
      mockSelect.mockResolvedValueOnce('none');
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
    // Real `pnpm-workspace.yaml` files frequently use
    // `{apps,packages}/*` and similar brace expansions.
    // `{apps,packages}/*` is expanded into `['apps/*', 'packages/*']`
    // BEFORE matching; otherwise no subpackage path matches and the
    // fresh-clone install branch aborts on the subpackage's
    // `workspace:*` spec.
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
      mockSelect.mockResolvedValueOnce('none');
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
      mockSelect.mockResolvedValueOnce('none');
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
      mockSelect.mockResolvedValueOnce('none');
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
      mockSelect.mockResolvedValueOnce('none');
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
    // The empty-project Pages starter branch
    // (`isScaffoldableEmptyProject(root)` → `scaffoldPagesApp`) must
    // detect workspace subpackages too. Installing with the fallback
    // `npm` package manager inside a pnpm workspace subpackage either
    // writes a stray `node_modules/` / `package-lock.json` that fights the
    // workspace manager's hoisting, or aborts on the template's
    // `workspace:` specs; `generateStarterMigration` fails the same way
    // because drizzle-kit can't resolve `void/schema-d1` from an
    // un-installed subpackage. Mirror the demo branch's skip.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      // Workspace root: pnpm-workspace.yaml declaring `packages/*`.
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

      // Subpackage: truly empty directory — no `package.json`, no files.
      // `isScaffoldableEmptyProject` returns true and
      // `runInitCommand` takes the Pages starter branch.
      const subpkgRoot = join(wsroot, 'packages', 'my-new-app');
      mkdirSync(subpkgRoot, { recursive: true });

      // Toolchain prompt → Vite+, framework prompt → vue, starter mode → sqlite.
      mockSelect
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('vue')
        .mockResolvedValueOnce('sqlite');
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
      expect(body).toContain(toSlash(wsroot));
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('omits the `void db generate` follow-up in the workspace skip note AND outro for static starter mode', async () => {
    // Static starter projects have no `db/schema.ts`, so the
    // workspace-subpackage note and outro must not tell the user to run
    // `void db generate`.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

      const subpkgRoot = join(wsroot, 'packages', 'static-starter');
      mkdirSync(subpkgRoot, { recursive: true });

      mockSelect
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('static');
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

  it('skips GitHub Actions setup for `void init --github` in a workspace subpackage', async () => {
    // `workspaceSubpackageSkip` is only set inside the interactive
    // `!targeted` scaffold branches, so a targeted `void init --github`
    // must detect membership itself. Step 8 checks
    // `isInsideWorkspaceSubpackage(root)` so the skip applies
    // independently of the interactive flag AND of whether the
    // subpackage manages its own install — GitHub does not read
    // `.github/workflows/deploy.yml` under a subpackage root.
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
      await runInitCommand(subpkgRoot, { github: true, tsconfig: false });

      // The deploy.yml MUST NOT have been written under the subpackage.
      const deployYmlPath = join(subpkgRoot, '.github', 'workflows', 'void-deploy.yml');
      expect(existsSync(deployYmlPath)).toBe(false);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('skips GitHub Actions setup for `void init --github` in a leaf-managed workspace subpackage', async () => {
    // `resolveWorkspaceDeferral()` returns `undefined` for leaf-managed
    // subpackages (local lockfile or a non-pnpm Corepack pin) because the
    // leaf owns its install. That's right for install/migration deferral,
    // but GitHub only reads `.github/workflows/*` from the repository
    // root regardless of who manages the install. Step 8 therefore uses
    // `isInsideWorkspaceSubpackage`, which only checks structural
    // membership. Cover both leaf-managed arms (local lockfile AND local
    // non-pnpm Corepack pin).
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

        await runInitCommand(subpkgRoot, { github: true, tsconfig: false });

        const deployYmlPath = join(subpkgRoot, '.github', 'workflows', 'void-deploy.yml');
        expect(existsSync(deployYmlPath)).toBe(false);
      } finally {
        rmSync(wsroot, { recursive: true, force: true });
      }
    }
  });

  it('runs install (does NOT take the workspace skip path) for a starter init when the subpackage has a local `packageManager: bun@…` Corepack pin', async () => {
    // `resolveWorkspaceDeferral` honors a local non-pnpm `packageManager`
    // Corepack pin as a self-management signal. This covers that arm
    // through `runInitCommand`'s starter branch.
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
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('sqlite');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      // Install MUST run — the leaf is self-managed via the local
      // Corepack pin, not deferred to the workspace. Assert it ran
      // through `bun`, not some other manager, which proves the local
      // Corepack pin was actually honored.
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

  it('honors a local `package-lock.json` veto for a yarn-leaf nested under a pnpm workspace', async () => {
    // `isPnpmProject` and the workspace-skip path must agree on the same
    // root: a leaf-managed subpackage with its own `package-lock.json` is
    // non-pnpm AND not deferred to the workspace.
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
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('vue')
        .mockResolvedValueOnce('sqlite');
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

  it('skips GitHub Actions setup when the workspace-subpackage skip path fires', async () => {
    // GitHub only reads `.github/workflows/*` from the repository root,
    // so writing `deploy.yml` UNDER the subpackage root would be silently
    // ignored. In skip mode, GitHub Actions setup is skipped entirely and
    // a note points the user back to the repo root.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

      const subpkgRoot = join(wsroot, 'packages', 'gha-skip');
      mkdirSync(subpkgRoot, { recursive: true });

      mockSelect
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('vue')
        .mockResolvedValueOnce('sqlite');
      // Demo prompt → no, GitHub Actions prompt → yes (the user opts in
      // but the skip path must override it because the workflow file
      // would land in the wrong place).
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

      await runInitCommand(subpkgRoot);

      // No `.github/workflows/deploy.yml` was written under the
      // subpackage — that file would never be read by GitHub.
      const deployYmlPath = join(subpkgRoot, '.github', 'workflows', 'void-deploy.yml');
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
    // Symmetric proof that the workspace-subpackage skip ONLY
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
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('sqlite');
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

  // For a workspace subpackage with no local lockfile / Corepack pin,
  // `detectProjectState` returns `'npm'`. Gating pnpm build approvals on
  // that would drop the subpackage's built-deps allowlist and suppress
  // better-sqlite3 / esbuild / sharp / workerd postinstalls on the next
  // workspace-root `pnpm install`. The allowlist is gated on the
  // ancestor-aware `isPnpmProject` check instead.
  it('writes pnpm allowBuilds for a pnpm workspace subpackage', async () => {
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      // Workspace root: pnpm-workspace.yaml with `packages/*`. The root
      // holds the Corepack pin — NOT the subpackage.
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      writeFileSync(
        join(wsroot, 'package.json'),
        JSON.stringify(
          { name: 'workspace-root', private: true, packageManager: 'pnpm@^12.4.1' },
          null,
          2,
        ) + '\n',
      );

      // Subpackage: empty directory, no local lockfile, no local
      // Corepack pin. `detectProjectState` returns `'npm'` here.
      const subpkgRoot = join(wsroot, 'packages', 'my-new-app');
      mkdirSync(subpkgRoot, { recursive: true });

      mockSelect
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('vue')
        .mockResolvedValueOnce('sqlite');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      const pkg = JSON.parse(readFileSync(join(subpkgRoot, 'package.json'), 'utf-8'));

      // The built-deps allowlist MUST be present in the workspace
      // config — this is the regression target. Mirrors the
      // standalone-pnpm assertion above.
      expectPnpmAllowBuilds(wsroot);
      expect(pkg.pnpm).toBeUndefined();
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('does NOT write a per-package `packageManager` pin in a pnpm workspace subpackage', async () => {
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
          { name: 'workspace-root', private: true, packageManager: 'pnpm@^12.4.1' },
          null,
          2,
        ) + '\n',
      );

      const subpkgRoot = join(wsroot, 'packages', 'my-new-app');
      mkdirSync(subpkgRoot, { recursive: true });

      mockSelect
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('sqlite');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      const pkg = JSON.parse(readFileSync(join(subpkgRoot, 'package.json'), 'utf-8'));
      expect(pkg.packageManager).toBeUndefined();
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('writes BOTH pnpm allowBuilds AND packageManager pin in a standalone pnpm project', async () => {
    // The standalone-pnpm path writes both the allowlist AND the
    // Corepack pin.
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      // Local `pnpm-lock.yaml` → `detectProjectState` picks pnpm.
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");

      mockSelect
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('vue')
        .mockResolvedValueOnce('sqlite');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expectPnpmAllowBuilds(root);
      expect(pkg.packageManager).toBe('pnpm@12.4.1');
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
              void: '^0.2.3',
            },
          },
          null,
          2,
        ) + '\n',
      );

      ensureVoidDependency(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      expect(pkg.devDependencies.void).toBe('^0.2.3');
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

  it('does NOT add a duplicate `void` entry when `void` is already declared in `peerDependencies`', () => {
    // A project with `peerDependencies.void` (e.g. a plugin author) must
    // not get a redundant `devDependencies.void` written on top, which can
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

describe('detectProjectState', () => {
  // When a repo pins a non-npm package manager via
  // `package.json#packageManager` (Corepack field) but hasn't committed a
  // lockfile yet, falling back to `npm` would run `npm install` on
  // pnpm/yarn workspaces, corrupting lockfiles or rejecting `workspace:`
  // specs before `generateStarterMigration()` could run.
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
    // Fresh Yarn repos honor the Corepack pin. Falling back to
    // `npm install` on a committed `packageManager: yarn@…` pin creates the
    // wrong lockfile and bypasses Yarn's linker/plugin settings.
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
    // A fresh pnpm workspace whose only pnpm marker is
    // `pnpm-workspace.yaml` (no `pnpm-lock.yaml` yet, no
    // `package.json#packageManager` pin) must not fall through to `npm`:
    // `npm install` either rejects `workspace:` specs outright or creates a stray
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
  // When `drizzle-kit generate` crashes mid-write — truncated journal,
  // partial snapshot, or an interrupted write during `void init` —
  // leftover artifacts in `db/migrations/` would make the next
  // `void db status` / `void db generate` / `void gen migration` refuse
  // in `assertJournalCoherence`, wedging the repo.
  // `generateStarterMigration` snapshots everything drizzle-kit might
  // touch before spawning, then restores/unlinks on failure. Mirrors the rollback pattern in
  // `gen.ts`'s `runMigration`, extended to handle the
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
