import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { toSlash } from 'pathslash';
import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { withPrivateDrizzleConfig, writeDrizzleConfig } from '../../src/drizzle/config.ts';

describe('writeDrizzleConfig', () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `void-drizzle-cfg-${Date.now()}`);
    mkdirSync(join(root, '.void'), { recursive: true });
    mkdirSync(join(root, 'db'), { recursive: true });
    writeFileSync(join(root, 'db/schema.ts'), 'export const users = {};');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes a valid JSON config to .void/', () => {
    const configPath = writeDrizzleConfig(root, '/tmp/test.sqlite');
    expect(configPath).toBe(toSlash(join(root, '.void', 'drizzle.config.json')));
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.dialect).toBe('sqlite');
    expect(config.schema).toBe('./db/schema.ts');
    expect(config.out).toBe('./db/migrations');
    expect(config.dbCredentials.url).toBe('/tmp/test.sqlite');
    expect(config.migrations).toEqual({ prefix: 'timestamp' });
  });

  it('generates PostgreSQL config', () => {
    const configPath = writeDrizzleConfig(root, 'postgresql://localhost/test', 'postgresql');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.dialect).toBe('postgresql');
    expect(config.schema).toBe('./db/schema.ts');
    expect(config.out).toBe('./db/migrations');
    expect(config.dbCredentials.url).toBe('postgresql://localhost/test');
  });

  it('generates MySQL config', () => {
    const configPath = writeDrizzleConfig(root, 'mysql://localhost/test', 'mysql');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.dialect).toBe('mysql');
    expect(config.schema).toBe('./db/schema.ts');
    expect(config.dbCredentials.url).toBe('mysql://localhost/test');
  });

  it('includes generated schemas alongside the application schema', () => {
    const authSchema = join(root, '.void', 'better-auth-schema.ts');
    writeFileSync(authSchema, 'export const user = {};');

    const configPath = writeDrizzleConfig(root, ':memory:', 'sqlite', {
      additionalSchemas: [authSchema],
    });

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.schema).toEqual(['./db/schema.ts', './.void/better-auth-schema.ts']);
  });

  it('supports an auth-only project without an application schema', () => {
    rmSync(join(root, 'db', 'schema.ts'));
    const authSchema = join(root, '.void', 'better-auth-schema.ts');
    writeFileSync(authSchema, 'export const user = {};');

    const configPath = writeDrizzleConfig(root, ':memory:', 'sqlite', {
      additionalSchemas: [authSchema],
    });

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.schema).toBe('./.void/better-auth-schema.ts');
  });
});

describe('withPrivateDrizzleConfig', () => {
  let root: string;
  const dbUrl = 'postgres://user:secret@db.example.com:5432/app';

  beforeEach(() => {
    root = join(tmpdir(), `void-drizzle-private-${Date.now()}`);
    mkdirSync(join(root, 'db'), { recursive: true });
    writeFileSync(join(root, 'db/schema.ts'), 'export const users = {};');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('passes a config outside the project that holds the database URL', () => {
    const result = withPrivateDrizzleConfig(root, dbUrl, 'postgresql', (configPath) => {
      expect(relative(root, configPath).startsWith('..')).toBe(true);
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(config.dbCredentials.url).toBe(dbUrl);
      expect(config.dialect).toBe('postgresql');
      expect(config.schema).toBe('./db/schema.ts');
      expect(config.out).toBe('./db/migrations');
      return 'ran';
    });
    expect(result).toBe('ran');
    expect(existsSync(join(root, '.void', 'drizzle.config.json'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('writes the config readable by the owner only', () => {
    withPrivateDrizzleConfig(root, dbUrl, 'postgresql', (configPath) => {
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(configPath)).mode & 0o777).toBe(0o700);
    });
  });

  it('removes the config after run returns', () => {
    let seen = '';
    withPrivateDrizzleConfig(root, dbUrl, 'postgresql', (configPath) => {
      seen = configPath;
    });
    expect(seen).not.toBe('');
    expect(existsSync(dirname(seen))).toBe(false);
  });

  it('removes the config after run throws', () => {
    let seen = '';
    expect(() =>
      withPrivateDrizzleConfig(root, dbUrl, 'mysql', (configPath) => {
        seen = configPath;
        throw new Error('drizzle-kit failed');
      }),
    ).toThrow('drizzle-kit failed');
    expect(seen).not.toBe('');
    expect(existsSync(dirname(seen))).toBe(false);
  });

  it('keeps a SIGINT listener only while run executes', () => {
    const before = process.listenerCount('SIGINT');
    withPrivateDrizzleConfig(root, dbUrl, 'postgresql', () => {
      expect(process.listenerCount('SIGINT')).toBe(before + 1);
    });
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('still reports a missing schema', () => {
    rmSync(join(root, 'db', 'schema.ts'));
    const before = process.listenerCount('SIGINT');
    expect(() => withPrivateDrizzleConfig(root, dbUrl, 'postgresql', () => undefined)).toThrow(
      'No Drizzle schema found',
    );
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('removes a project config that an older CLI left with a database URL', () => {
    const leftover = join(root, '.void', 'drizzle.config.json');
    mkdirSync(dirname(leftover), { recursive: true });
    writeFileSync(
      leftover,
      JSON.stringify({ dialect: 'postgresql', dbCredentials: { url: 'postgres://u:old@db/app' } }),
    );
    withPrivateDrizzleConfig(root, dbUrl, 'postgresql', () => undefined);
    expect(existsSync(leftover)).toBe(false);
  });

  it.each(['postgresql://dummy', 'mysql://dummy', ':memory:', '/project/.void/local.sqlite'])(
    'keeps a project config whose URL is %j',
    (url) => {
      const config = join(root, '.void', 'drizzle.config.json');
      mkdirSync(dirname(config), { recursive: true });
      writeFileSync(config, JSON.stringify({ dbCredentials: { url } }));
      withPrivateDrizzleConfig(root, dbUrl, 'postgresql', () => undefined);
      expect(existsSync(config)).toBe(true);
    },
  );
});
