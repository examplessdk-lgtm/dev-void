import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vite-plus/test';
import { detectHttpExports } from '../../src/router/detect-exports.ts';

const TMP = join(import.meta.dirname, '__tmp_detect_test__');

function writeRoute(filename: string, content: string): string {
  const full = join(TMP, filename);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  return full;
}

describe('detectHttpExports', () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('detects export function POST', () => {
    const path = writeRoute('hello.ts', 'export function POST() { return "ok"; }');
    expect(detectHttpExports(path)).toEqual(['POST']);
  });

  it('detects re-exported methods', () => {
    const path = writeRoute(
      'hello.ts',
      `const handler = () => "ok";
export { handler as GET };`,
    );
    expect(detectHttpExports(path)).toEqual(['GET']);
  });

  it('ignores non-HTTP exports', () => {
    const path = writeRoute(
      'hello.ts',
      `export const GET = () => "ok";
export const helper = () => {};
export function transform() {}`,
    );
    expect(detectHttpExports(path)).toEqual(['GET']);
  });

  it('ignores a type-only export statement', () => {
    // `export type { GET }` erases at runtime, so it must not register a GET route.
    const path = writeRoute(
      'hello.ts',
      `type GET = () => Response;
export type { GET };`,
    );
    expect(detectHttpExports(path)).toEqual([]);
  });

  it('ignores an inline type-only specifier but keeps value specifiers', () => {
    const path = writeRoute(
      'hello.ts',
      `const POST = () => "ok";
type GET = () => Response;
export { POST, type GET };`,
    );
    expect(detectHttpExports(path)).toEqual(['POST']);
  });

  it('returns empty array for no HTTP exports', () => {
    const path = writeRoute('hello.ts', 'export default () => "ok";');
    expect(detectHttpExports(path)).toEqual([]);
  });

  it('detects all standard HTTP methods', () => {
    const path = writeRoute(
      'all.ts',
      `export const GET = () => {};
export const POST = () => {};
export const PUT = () => {};
export const PATCH = () => {};
export const DELETE = () => {};
export const OPTIONS = () => {};
export const HEAD = () => {};`,
    );
    expect(detectHttpExports(path)).toEqual([
      'GET',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'OPTIONS',
      'HEAD',
    ]);
  });

  it('handles invalid syntax gracefully', () => {
    const path = writeRoute('bad.ts', 'this is not valid {{{ code');
    expect(detectHttpExports(path)).toEqual([]);
  });
});
