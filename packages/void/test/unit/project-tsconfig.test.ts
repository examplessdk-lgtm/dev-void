import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureProjectTsconfig } from '../../src/codegen/project-tsconfig';

describe('ensureProjectTsconfig', () => {
  let root: string;

  beforeEach(() => {
    root = join(
      tmpdir(),
      `void-tsconfig-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(root, '.void'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function readTsconfig() {
    return JSON.parse(readFileSync(join(root, '.void', 'tsconfig.json'), 'utf-8'));
  }

  it('creates tsconfig.json in .void directory', () => {
    ensureProjectTsconfig(root);
    expect(existsSync(join(root, '.void', 'tsconfig.json'))).toBe(true);
  });

  it('includes routes.d.ts when routes/ directory exists', () => {
    mkdirSync(join(root, 'routes'), { recursive: true });
    ensureProjectTsconfig(root);
    const tsconfig = readTsconfig();
    expect(tsconfig.files).toContain('routes.d.ts');
    expect(tsconfig.compilerOptions.paths['void/routes']).toEqual(['./routes.d.ts']);
  });

  it('excludes routes.d.ts when no routes/ directory', () => {
    ensureProjectTsconfig(root);
    const tsconfig = readTsconfig();
    expect(tsconfig.files).not.toContain('routes.d.ts');
  });

  it('includes routes.d.ts when hasRouteTypes is explicitly true', () => {
    ensureProjectTsconfig(root, true);
    const tsconfig = readTsconfig();
    expect(tsconfig.files).toContain('routes.d.ts');
  });

  it('includes queues.d.ts when queues/ directory exists', () => {
    mkdirSync(join(root, 'queues'), { recursive: true });
    ensureProjectTsconfig(root);
    const tsconfig = readTsconfig();
    expect(tsconfig.files).toContain('queues.d.ts');
    expect(tsconfig.compilerOptions.paths['void/queues']).toEqual(['./queues.d.ts']);
  });

  it('includes db.d.ts when hasDb is true', () => {
    ensureProjectTsconfig(root, undefined, true);
    const tsconfig = readTsconfig();
    expect(tsconfig.files).toContain('db.d.ts');
    expect(tsconfig.compilerOptions.paths['void/db']).toEqual(['./db.d.ts']);
  });

  it('auto-detects md.d.ts and adds paths entry', () => {
    writeFileSync(
      join(root, '.void', 'md.d.ts'),
      'declare const pages: any[]; export default pages;',
    );
    ensureProjectTsconfig(root);
    const tsconfig = readTsconfig();
    expect(tsconfig.files).toContain('md.d.ts');
    expect(tsconfig.compilerOptions.paths['@void/md/pages']).toEqual(['./md.d.ts']);
  });

  it('excludes md.d.ts when file does not exist', () => {
    ensureProjectTsconfig(root);
    const tsconfig = readTsconfig();
    expect(tsconfig.files).not.toContain('md.d.ts');
    expect(tsconfig.compilerOptions?.paths?.['@void/md/pages']).toBeUndefined();
  });

  it('preserves md.d.ts across repeated calls', () => {
    writeFileSync(
      join(root, '.void', 'md.d.ts'),
      'declare const pages: any[]; export default pages;',
    );

    ensureProjectTsconfig(root);
    ensureProjectTsconfig(root);
    ensureProjectTsconfig(root);

    const tsconfig = readTsconfig();
    expect(tsconfig.files).toContain('md.d.ts');
    expect(tsconfig.compilerOptions.paths['@void/md/pages']).toEqual(['./md.d.ts']);
  });

  it('combines routes, queues, and md when all present', () => {
    mkdirSync(join(root, 'routes'), { recursive: true });
    mkdirSync(join(root, 'queues'), { recursive: true });
    writeFileSync(join(root, '.void', 'md.d.ts'), 'export default [];');

    ensureProjectTsconfig(root, undefined, true);
    const tsconfig = readTsconfig();

    expect(tsconfig.files).toContain('routes.d.ts');
    expect(tsconfig.files).toContain('db.d.ts');
    expect(tsconfig.files).toContain('queues.d.ts');
    expect(tsconfig.files).toContain('md.d.ts');
    expect(tsconfig.compilerOptions.paths['void/routes']).toEqual(['./routes.d.ts']);
    expect(tsconfig.compilerOptions.paths['void/db']).toEqual(['./db.d.ts']);
    expect(tsconfig.compilerOptions.paths['void/queues']).toEqual(['./queues.d.ts']);
    expect(tsconfig.compilerOptions.paths['@void/md/pages']).toEqual(['./md.d.ts']);
  });

  it('configures @schema paths when hasSchema is true', () => {
    ensureProjectTsconfig(root, undefined, true, true);
    const tsconfig = readTsconfig();
    expect(tsconfig.compilerOptions.paths['@schema']).toBeDefined();
  });
});
