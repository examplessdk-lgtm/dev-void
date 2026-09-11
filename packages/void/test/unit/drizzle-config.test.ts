import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { writeDrizzleConfig } from '../../src/drizzle/config.ts';

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
    expect(configPath).toBe(join(root, '.void', 'drizzle.config.json'));
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.dialect).toBe('sqlite');
    expect(config.schema).toBe('./db/schema.ts');
    expect(config.out).toBe('./db/migrations');
    expect(config.dbCredentials.url).toBe('/tmp/test.sqlite');
  });

  it('generates SQLite config by default', () => {
    const configPath = writeDrizzleConfig(root, '/tmp/test.sqlite');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.dialect).toBe('sqlite');
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

  it('generates SQLite config with explicit dialect', () => {
    const configPath = writeDrizzleConfig(root, '/tmp/test.sqlite', 'sqlite');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.dialect).toBe('sqlite');
    expect(config.dbCredentials.url).toBe('/tmp/test.sqlite');
  });

  it('uses timestamp migration prefix for SQLite', () => {
    const configPath = writeDrizzleConfig(root, '/tmp/test.sqlite');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.migrations).toEqual({ prefix: 'timestamp' });
  });

  it('uses timestamp migration prefix for PostgreSQL', () => {
    const configPath = writeDrizzleConfig(root, 'postgresql://localhost/test', 'postgresql');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.migrations).toEqual({ prefix: 'timestamp' });
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
