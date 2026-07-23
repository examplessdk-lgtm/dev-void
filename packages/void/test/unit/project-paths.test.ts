import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { readConfig } from '../../src/config.ts';
import {
  assertNoRootSourceConventionConflicts,
  readProjectPaths,
  resolvePagesDir,
  resolveProjectPaths,
  validateSourceDir,
} from '../../src/project-paths.ts';

describe('project path resolution', () => {
  let root: string;

  beforeEach(() => {
    root = join(
      tmpdir(),
      `void-project-paths-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeConfig(config: Record<string, unknown>) {
    writeFileSync(join(root, 'void.json'), JSON.stringify(config, null, 2));
  }

  it('keeps existing root conventions when sourceDir is omitted', () => {
    const paths = resolveProjectPaths(root, {});
    expect(paths.sourceDir).toBe('');
    expect(paths.sourceRoot).toBe(root);
    expect(paths.routesDir).toBe(join(root, 'routes'));
    expect(paths.pagesDir).toBe(join(root, 'pages'));
    expect(paths.middlewareDir).toBe(join(root, 'middleware'));
    expect(paths.cronsDir).toBe(join(root, 'crons'));
    expect(paths.queuesDir).toBe(join(root, 'queues'));
    expect(paths.dbDir).toBe(join(root, 'db'));
    expect(paths.migrationsDir).toBe(join(root, 'db', 'migrations'));
    expect(paths.schemaFile).toBe(join(root, 'db', 'schema.ts'));
    expect(paths.ssrDir).toBe(join(root, 'src'));
    expect(paths.sourceRelative('db/migrations')).toBe('db/migrations');
  });

  it('moves Void source conventions under sourceDir', () => {
    const paths = resolveProjectPaths(root, { sourceDir: 'src' });
    expect(paths.sourceDir).toBe('src');
    expect(paths.sourceRoot).toBe(join(root, 'src'));
    expect(paths.routesDir).toBe(join(root, 'src', 'routes'));
    expect(paths.pagesDir).toBe(join(root, 'src', 'pages'));
    expect(paths.middlewareDir).toBe(join(root, 'src', 'middleware'));
    expect(paths.cronsDir).toBe(join(root, 'src', 'crons'));
    expect(paths.queuesDir).toBe(join(root, 'src', 'queues'));
    expect(paths.dbDir).toBe(join(root, 'src', 'db'));
    expect(paths.migrationsDir).toBe(join(root, 'src', 'db', 'migrations'));
    expect(paths.schemaFile).toBe(join(root, 'src', 'db', 'schema.ts'));
    expect(paths.ssrDir).toBe(join(root, 'src'));
    expect(paths.sourceRelative('db/migrations')).toBe('src/db/migrations');
  });

  it('supports arbitrary nested source directories', () => {
    const paths = resolveProjectPaths(root, { sourceDir: 'app/server' });
    expect(paths.routesDir).toBe(join(root, 'app', 'server', 'routes'));
    expect(paths.pagesDir).toBe(join(root, 'app', 'server', 'pages'));
    expect(paths.schemaDir).toBe(join(root, 'app', 'server', 'db', 'schema'));
    expect(paths.sourceRelative('routes/api')).toBe('app/server/routes/api');
  });

  it('reads sourceDir from root void.json', () => {
    writeConfig({ sourceDir: 'src' });
    expect(readProjectPaths(root).pagesDir).toBe(join(root, 'src', 'pages'));
    expect(resolvePagesDir(root)).toBe(join(root, 'src', 'pages'));
  });

  it('keeps env.ts back compat candidates when sourceDir is omitted', () => {
    const paths = resolveProjectPaths(root, {});
    expect(paths.envFileCandidates).toEqual([
      join(root, 'env.ts'),
      join(root, 'env.mts'),
      join(root, 'env.js'),
      join(root, 'env.mjs'),
      join(root, 'src', 'env.ts'),
      join(root, 'src', 'env.mts'),
      join(root, 'src', 'env.js'),
      join(root, 'src', 'env.mjs'),
    ]);
  });

  it('uses only sourceDir env.ts candidates when sourceDir is configured', () => {
    const paths = resolveProjectPaths(root, { sourceDir: 'app' });
    expect(paths.envFileCandidates).toEqual([
      join(root, 'app', 'env.ts'),
      join(root, 'app', 'env.mts'),
      join(root, 'app', 'env.js'),
      join(root, 'app', 'env.mjs'),
    ]);
  });

  it('validates sourceDir shape', () => {
    expect(validateSourceDir('src')).toBe('src');
    expect(validateSourceDir('src/feature')).toBe('src/feature');
    for (const value of [
      '',
      ' src',
      'src ',
      '.',
      './',
      '..',
      '../src',
      'src/../app',
      'src/..',
      '/src',
    ]) {
      expect(() => validateSourceDir(value)).toThrow(/relative directory/);
    }
  });

  it('validates sourceDir through readConfig', () => {
    writeConfig({ sourceDir: 'src' });
    expect(readConfig(root).sourceDir).toBe('src');

    writeConfig({ sourceDir: '../src' });
    expect(() => readConfig(root)).toThrow(/sourceDir/);
  });

  it('validates sourceDir through readProjectPaths', () => {
    writeConfig({ sourceDir: 'src/..' });
    expect(() => readProjectPaths(root)).toThrow(/sourceDir/);

    writeConfig({ sourceDir: './' });
    expect(() => readProjectPaths(root)).toThrow(/sourceDir/);
  });

  it('does not report conflicts when sourceDir is omitted', () => {
    mkdirSync(join(root, 'routes'), { recursive: true });
    mkdirSync(join(root, 'src', 'routes'), { recursive: true });
    expect(() =>
      assertNoRootSourceConventionConflicts(resolveProjectPaths(root, {})),
    ).not.toThrow();
  });

  it('fails when root and source conventions both exist with sourceDir', () => {
    mkdirSync(join(root, 'routes'), { recursive: true });
    mkdirSync(join(root, 'src', 'routes'), { recursive: true });
    mkdirSync(join(root, 'db'), { recursive: true });
    mkdirSync(join(root, 'src', 'db'), { recursive: true });

    expect(() =>
      assertNoRootSourceConventionConflicts(resolveProjectPaths(root, { sourceDir: 'src' })),
    ).toThrow(/routes, db/);
  });

  it('does not treat project-root config and public files as source conflicts', () => {
    writeConfig({ sourceDir: 'src' });
    mkdirSync(join(root, 'public'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'vite.config.ts'), 'export default {};');
    writeFileSync(join(root, 'package.json'), '{}');

    expect(() => assertNoRootSourceConventionConflicts(readProjectPaths(root))).not.toThrow();
    expect(existsSync(join(root, 'void.json'))).toBe(true);
  });
});
