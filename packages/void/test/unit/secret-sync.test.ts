import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseDotenvFile } from "../../src/cli/secret";

function writeTemp(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "secret-sync-"));
  const file = join(dir, ".env");
  writeFileSync(file, content);
  return file;
}

describe("parseDotenvFile", () => {
  it("parses basic KEY=value pairs", () => {
    const file = writeTemp("API_KEY=abc123\nDB_URL=postgres://localhost");
    expect(parseDotenvFile(file)).toEqual([
      { name: "API_KEY", value: "abc123" },
      { name: "DB_URL", value: "postgres://localhost" },
    ]);
  });

  it("strips double quotes from values", () => {
    const file = writeTemp('SECRET="my secret value"');
    expect(parseDotenvFile(file)).toEqual([{ name: "SECRET", value: "my secret value" }]);
  });

  it("strips single quotes from values", () => {
    const file = writeTemp("SECRET='my secret value'");
    expect(parseDotenvFile(file)).toEqual([{ name: "SECRET", value: "my secret value" }]);
  });

  it("skips comments and blank lines", () => {
    const file = writeTemp("# This is a comment\n\nAPI_KEY=value\n  \n# Another comment\nSECRET=x");
    expect(parseDotenvFile(file)).toEqual([
      { name: "API_KEY", value: "value" },
      { name: "SECRET", value: "x" },
    ]);
  });

  it("handles values with = signs", () => {
    const file = writeTemp("BASE64=abc=def==");
    expect(parseDotenvFile(file)).toEqual([{ name: "BASE64", value: "abc=def==" }]);
  });

  it("handles empty values", () => {
    const file = writeTemp("EMPTY=");
    expect(parseDotenvFile(file)).toEqual([{ name: "EMPTY", value: "" }]);
  });

  it("handles values with spaces around =", () => {
    const file = writeTemp("KEY = value");
    expect(parseDotenvFile(file)).toEqual([{ name: "KEY", value: "value" }]);
  });

  it("errors on lowercase key names", () => {
    const file = writeTemp("lowercase=value");
    expect(() => parseDotenvFile(file)).toThrow("Invalid secret name: lowercase");
  });

  it("errors on keys with special characters", () => {
    const file = writeTemp("MY-KEY=value");
    expect(() => parseDotenvFile(file)).toThrow("Invalid secret name: MY-KEY");
  });

  it("errors on keys starting with a digit", () => {
    const file = writeTemp("1KEY=value");
    expect(() => parseDotenvFile(file)).toThrow("Invalid secret name: 1KEY");
  });

  it("errors on lines without =", () => {
    const file = writeTemp("NOTAVALIDLINE");
    expect(() => parseDotenvFile(file)).toThrow("Invalid line (missing =)");
  });

  it("returns empty array for empty file", () => {
    const file = writeTemp("");
    expect(parseDotenvFile(file)).toEqual([]);
  });

  it("returns empty array for comments-only file", () => {
    const file = writeTemp("# comment\n# another");
    expect(parseDotenvFile(file)).toEqual([]);
  });
});
