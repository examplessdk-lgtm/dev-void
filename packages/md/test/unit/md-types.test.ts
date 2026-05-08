import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { generateMdTypes } from '../../src/codegen/md-types.ts';

/**
 * Tests for the md type declaration generation.
 *
 * The md plugin generates .void/md.d.ts during buildStart, providing
 * TypeScript type information for the @void/md/pages virtual module.
 * ensureProjectTsconfig then auto-detects this file and adds a paths
 * override so TypeScript resolves the generated types instead of the package stub.
 */

describe('md type declarations', () => {
  let root: string;

  beforeEach(() => {
    root = join(
      tmpdir(),
      `void-md-types-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(root, '.void'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('generates a valid TypeScript declaration', () => {
    const dts = generateMdTypes();
    expect(dts).toContain('interface VoidMdPage');
    expect(dts).toContain('path: string');
    expect(dts).toContain('title: string');
    expect(dts).toContain('frontmatter: Record<string, unknown>');
    expect(dts).toContain('headings: Array<{ depth: number; slug: string; text: string }>');
    expect(dts).toContain('declare const pages: Array<VoidMdPage>');
    expect(dts).toContain('export default pages');
  });

  it('can be written to .void/md.d.ts', () => {
    const dtsPath = join(root, '.void', 'md.d.ts');
    writeFileSync(dtsPath, generateMdTypes());
    expect(existsSync(dtsPath)).toBe(true);
    const content = readFileSync(dtsPath, 'utf-8');
    expect(content).toContain('VoidMdPage');
  });

  it('pages.d.ts package stub matches the generated declaration shape', () => {
    // The package export stub (pages.d.ts) and the generated .void/md.d.ts
    // must declare the same type shape so the paths override is compatible.
    const stubPath = join(__dirname, '../../pages.d.ts');
    const stub = readFileSync(stubPath, 'utf-8');
    const generated = generateMdTypes();

    // Both should declare VoidMdPage with the same fields
    expect(stub).toContain('path: string');
    expect(stub).toContain('title: string');
    expect(stub).toContain('frontmatter: Record<string, unknown>');
    expect(stub).toContain('headings: Array<{ depth: number; slug: string; text: string }>');
    expect(generated).toContain('path: string');
    expect(generated).toContain('title: string');
    expect(generated).toContain('frontmatter: Record<string, unknown>');
    expect(generated).toContain('headings: Array<{ depth: number; slug: string; text: string }>');

    // Both should export pages as default
    expect(stub).toContain('export default pages');
    expect(generated).toContain('export default pages');
  });
});
