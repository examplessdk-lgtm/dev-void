import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toSlash } from 'pathslash';
import { describe, it, expect } from 'vite-plus/test';
import { generateEnvTypes, findEnvFile } from '../../src/codegen/env-types.ts';

function withTempProject(setup: (root: string) => void): {
  root: string;
  outDir: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'void-env-codegen-'));
  setup(root);
  const outDir = join(root, '.void');
  mkdirSync(outDir, { recursive: true });
  return {
    root,
    outDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('findEnvFile', () => {
  it('returns null when no env file exists', () => {
    const { root, cleanup } = withTempProject(() => {});
    try {
      expect(findEnvFile(root)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('finds env.ts at project root', () => {
    const { root, cleanup } = withTempProject((r) => {
      writeFileSync(join(r, 'env.ts'), 'export default {};');
    });
    try {
      expect(findEnvFile(root)).toBe(toSlash(join(root, 'env.ts')));
    } finally {
      cleanup();
    }
  });

  it('prefers env.ts over env.js', () => {
    const { root, cleanup } = withTempProject((r) => {
      writeFileSync(join(r, 'env.ts'), '');
      writeFileSync(join(r, 'env.js'), '');
    });
    try {
      expect(findEnvFile(root)).toBe(toSlash(join(root, 'env.ts')));
    } finally {
      cleanup();
    }
  });

  it('discovers env.ts inside src/ when no root-level file exists', () => {
    const { root, cleanup } = withTempProject((r) => {
      mkdirSync(join(r, 'src'), { recursive: true });
      writeFileSync(join(r, 'src', 'env.ts'), 'export default {};');
    });
    try {
      expect(findEnvFile(root)).toBe(toSlash(join(root, 'src', 'env.ts')));
    } finally {
      cleanup();
    }
  });

  it('prefers root-level env.ts over src/env.ts', () => {
    const { root, cleanup } = withTempProject((r) => {
      writeFileSync(join(r, 'env.ts'), '');
      mkdirSync(join(r, 'src'), { recursive: true });
      writeFileSync(join(r, 'src', 'env.ts'), '');
    });
    try {
      expect(findEnvFile(root)).toBe(toSlash(join(root, 'env.ts')));
    } finally {
      cleanup();
    }
  });
});

describe('generateEnvTypes', () => {
  it('emits a module that augments void/env and void/handler', () => {
    const { root, outDir, cleanup } = withTempProject((r) => {
      writeFileSync(join(r, 'env.ts'), 'export default {};');
    });
    try {
      const { dts } = generateEnvTypes(join(root, 'env.ts'), outDir);
      expect(dts).toContain('export {}');
      expect(dts).toContain('declare module "void/env"');
      expect(dts).toContain('declare module "void/handler"');
      expect(dts).toContain('interface ValidatedEnv extends _VoidEnvShape');
      expect(dts).toContain('interface CloudBindings extends _VoidEnvShape');
      // Path is relative to outDir and keeps the source extension for NodeNext.
      expect(dts).toContain('typeof import("../env.ts")');
      // Resolves both `export default defineEnv(...)` and
      // `export const env = defineEnv(...)` source forms.
      expect(dts).toContain(
        'type _VoidEnvShape = _VoidEnvSchema extends { default: infer D } ? D : _VoidEnvSchema extends { env: infer E } ? E : {};',
      );
    } finally {
      cleanup();
    }
  });
});
