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
  generateStarterMigration,
  getTodayCompatDate,
  isScaffoldableEmptyProject,
  runInitCommand,
} from '../../src/cli/init';

const mockSpawnSync = vi.fn();
const mockSelect = vi.fn();
const mockConfirm = vi.fn();
const mockText = vi.fn();
const mockGetToken = vi.fn();
const mockRunLogin = vi.fn();
const mockSaveToken = vi.fn();
const mockIsStagingMode = vi.fn();
const mockListProjects = vi.fn();
const mockCreateProject = vi.fn();

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
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
      expect(mockSpawnSync).toHaveBeenCalledWith(
        'pnpm',
        ['install'],
        expect.objectContaining({
          cwd: root,
          stdio: 'inherit',
          shell: process.platform === 'win32',
        }),
      );

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

  it('falls back to npm for starter dependency installation when pnpm is unavailable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      mockSpawnSync.mockImplementation((command, args) => {
        if (command === 'pnpm' && Array.isArray(args) && args[0] === '--version') {
          return { status: 1, stdout: '', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      });
      mockSelect
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('static')
        .mockResolvedValueOnce('generic');
      mockConfirm.mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'pnpm',
        ['--version'],
        expect.objectContaining({
          stdio: 'ignore',
          shell: process.platform === 'win32',
        }),
      );
      expect(mockSpawnSync).toHaveBeenCalledWith(
        'npm',
        ['install'],
        expect.objectContaining({
          cwd: root,
          stdio: 'inherit',
          shell: process.platform === 'win32',
        }),
      );
      expect(mockSpawnSync).not.toHaveBeenCalledWith('pnpm', ['install'], expect.anything());
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
