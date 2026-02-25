import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { detectHttpExports } from "../../src/router/detect-exports";

const TMP = join(import.meta.dirname, "__tmp_detect_test__");

function writeRoute(filename: string, content: string): string {
  const full = join(TMP, filename);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  return full;
}

describe("detectHttpExports", () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("detects export const GET", () => {
    const path = writeRoute("hello.ts", 'export const GET = () => "ok";');
    expect(detectHttpExports(path)).toEqual(["GET"]);
  });

  it("detects export function POST", () => {
    const path = writeRoute("hello.ts", 'export function POST() { return "ok"; }');
    expect(detectHttpExports(path)).toEqual(["POST"]);
  });

  it("detects multiple methods", () => {
    const path = writeRoute(
      "users.ts",
      `export const GET = () => [];
export const POST = () => ({ created: true });
export const DELETE = () => ({ deleted: true });`,
    );
    expect(detectHttpExports(path)).toEqual(["GET", "POST", "DELETE"]);
  });

  it("detects re-exported methods", () => {
    const path = writeRoute(
      "hello.ts",
      `const handler = () => "ok";
export { handler as GET };`,
    );
    expect(detectHttpExports(path)).toEqual(["GET"]);
  });

  it("ignores non-HTTP exports", () => {
    const path = writeRoute(
      "hello.ts",
      `export const GET = () => "ok";
export const helper = () => {};
export function transform() {}`,
    );
    expect(detectHttpExports(path)).toEqual(["GET"]);
  });

  it("returns empty array for no HTTP exports", () => {
    const path = writeRoute("hello.ts", 'export default () => "ok";');
    expect(detectHttpExports(path)).toEqual([]);
  });

  it("detects all standard HTTP methods", () => {
    const path = writeRoute(
      "all.ts",
      `export const GET = () => {};
export const POST = () => {};
export const PUT = () => {};
export const PATCH = () => {};
export const DELETE = () => {};
export const OPTIONS = () => {};
export const HEAD = () => {};`,
    );
    expect(detectHttpExports(path)).toEqual([
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
      "HEAD",
    ]);
  });

  it("handles invalid syntax gracefully", () => {
    const path = writeRoute("bad.ts", "this is not valid {{{ code");
    expect(detectHttpExports(path)).toEqual([]);
  });
});
