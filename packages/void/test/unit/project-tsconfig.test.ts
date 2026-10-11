import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { ensureProjectTsconfig } from '../../src/codegen/project-tsconfig.ts';

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

  it('uses sourceDir conventions for route, queue, and schema paths', () => {
    writeFileSync(join(root, 'void.json'), JSON.stringify({ sourceDir: 'src' }));
    mkdirSync(join(root, 'src', 'routes'), { recursive: true });
    mkdirSync(join(root, 'src', 'queues'), { recursive: true });
    mkdirSync(join(root, 'src', 'db'), { recursive: true });
    writeFileSync(join(root, 'src', 'db', 'schema.ts'), 'export const users = {};');

    ensureProjectTsconfig(root, undefined, true, true);
    const tsconfig = readTsconfig();

    expect(tsconfig.files).toEqual(
      expect.arrayContaining(['routes.d.ts', 'queues.d.ts', 'db.d.ts']),
    );
    expect(tsconfig.compilerOptions.paths['@schema']).toEqual(['../src/db/schema.ts']);
    expect(tsconfig.compilerOptions.paths['@schema/*']).toEqual(['../src/db/schema/*']);
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
    expect(tsconfig.compilerOptions.paths['void/routes']).toEqual(['./routes.d.ts']);
  });

  it('does not rewrite tsconfig.json when generated content is unchanged', () => {
    const tsconfigPath = join(root, '.void', 'tsconfig.json');
    const oldTime = new Date('2024-01-01T00:00:00.000Z');

    ensureProjectTsconfig(root);
    utimesSync(tsconfigPath, oldTime, oldTime);

    ensureProjectTsconfig(root);
    expect(statSync(tsconfigPath).mtimeMs).toBe(oldTime.getTime());

    mkdirSync(join(root, 'routes'), { recursive: true });
    ensureProjectTsconfig(root);
    expect(statSync(tsconfigPath).mtimeMs).not.toBe(oldTime.getTime());
  });

  it('combines routes, queues, and db', () => {
    mkdirSync(join(root, 'routes'), { recursive: true });
    mkdirSync(join(root, 'queues'), { recursive: true });

    ensureProjectTsconfig(root, undefined, true);
    const tsconfig = readTsconfig();

    expect(tsconfig.files).toContain('routes.d.ts');
    expect(tsconfig.files).toContain('db.d.ts');
    expect(tsconfig.files).toContain('queues.d.ts');
    expect(tsconfig.compilerOptions.paths['void/routes']).toEqual(['./routes.d.ts']);
    expect(tsconfig.compilerOptions.paths['void/db']).toEqual(['./db.d.ts']);
    expect(tsconfig.compilerOptions.paths['void/queues']).toEqual(['./queues.d.ts']);
  });
});
