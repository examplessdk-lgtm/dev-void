import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { getSsrServerEntryPath, hasSsrEntry, validateSsrEntry } from '../../src/ssr/entry.ts';

const tempDirs: Array<string> = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-ssr-entry-'));
  tempDirs.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}

describe('ssr entry helpers', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when ssr entry is missing', () => {
    const root = createTempRoot();
    expect(hasSsrEntry(root)).toBe(false);
    expect(getSsrServerEntryPath(root)).toBeNull();
    expect(validateSsrEntry(root)).toBeNull();
  });

  it('validates exported render function', () => {
    const root = createTempRoot();
    const file = join(root, 'src', 'main.ssr.ts');
    writeFileSync(
      join(root, 'src', 'main.client.tsx'),
      "import { hydrateRoot } from 'react-dom/client'; hydrateRoot(document, null);",
    );
    writeFileSync(
      file,
      "export async function render(request, env) { return new Response('ok'); }",
    );

    expect(hasSsrEntry(root)).toBe(true);
    expect(validateSsrEntry(root)).toBe(file);
  });

  it('supports tsx ssr entry files', () => {
    const root = createTempRoot();
    const file = join(root, 'src', 'main.ssr.tsx');
    writeFileSync(join(root, 'src', 'main.client.ts'), "console.log('client entry');");
    writeFileSync(
      file,
      "export async function render(request, env) { return new Response('<div>ok</div>'); }",
    );

    expect(hasSsrEntry(root)).toBe(true);
    expect(validateSsrEntry(root)).toBe(file);
  });

  it('supports default defineRender export', () => {
    const root = createTempRoot();
    const file = join(root, 'src', 'main.ssr.ts');
    writeFileSync(join(root, 'src', 'main.client.ts'), "console.log('client entry');");
    writeFileSync(
      file,
      "import { defineRender } from 'void'; export default defineRender(async () => new Response('ok'));",
    );

    expect(hasSsrEntry(root)).toBe(true);
    expect(validateSsrEntry(root)).toBe(file);
  });

  it('throws when both ts and tsx ssr entries exist', () => {
    const root = createTempRoot();
    writeFileSync(join(root, 'src', 'main.client.ts'), "console.log('client entry');");
    writeFileSync(
      join(root, 'src', 'main.ssr.ts'),
      "export async function render(request, env) { return new Response('ok'); }",
    );
    writeFileSync(
      join(root, 'src', 'main.ssr.tsx'),
      "export async function render(request, env) { return new Response('ok'); }",
    );

    expect(() => validateSsrEntry(root)).toThrow('Multiple SSR entry files found');
  });

  it('throws for missing render export', () => {
    const root = createTempRoot();
    writeFileSync(join(root, 'src', 'main.client.ts'), "console.log('client entry');");
    writeFileSync(
      join(root, 'src', 'main.ssr.ts'),
      "export const notRender = () => new Response('ok');",
    );

    expect(() => validateSsrEntry(root)).toThrow(
      'Export `render(c, assetTags)` or `export default defineRender(...)`',
    );
  });

  it('throws when server entry exists without client entry', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'src', 'main.ssr.ts'),
      "export async function render(request, env) { return new Response('ok'); }",
    );

    expect(() => validateSsrEntry(root)).toThrow('ssr: Missing client entry');
  });

  it('throws when client entry exists without server entry', () => {
    const root = createTempRoot();
    writeFileSync(join(root, 'src', 'main.client.ts'), "console.log('client entry');");

    expect(() => validateSsrEntry(root)).toThrow('ssr: Missing server entry');
  });
});
