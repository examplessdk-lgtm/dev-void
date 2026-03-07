import { describe, expect, it } from "vitest";
import { parseDbArgs } from "../../src/cli/db-args";

describe("parseDbArgs", () => {
  it("parses status", () => {
    expect(parseDbArgs(["status"])).toEqual({ action: "status" });
  });

  it("parses reset", () => {
    expect(parseDbArgs(["reset"])).toEqual({ action: "reset" });
  });

  it("parses seed", () => {
    expect(parseDbArgs(["seed"])).toEqual({ action: "seed", file: undefined });
  });

  it("parses seed with --file", () => {
    expect(parseDbArgs(["seed", "--file", "custom.sql"])).toEqual({
      action: "seed",
      file: "custom.sql",
    });
  });

  it("parses execute with inline SQL", () => {
    expect(parseDbArgs(["execute", "SELECT * FROM users"])).toEqual({
      action: "execute",
      command: "SELECT * FROM users",
      file: undefined,
    });
  });

  it("parses execute with --file", () => {
    expect(parseDbArgs(["execute", "--file", "query.sql"])).toEqual({
      action: "execute",
      command: undefined,
      file: "query.sql",
    });
  });

  it("errors on execute with no SQL and no --file", () => {
    expect(() => parseDbArgs(["execute"])).toThrow(
      "Error: Usage: void db execute <sql> or void db execute --file <path>",
    );
  });

  it("errors on execute with both SQL and --file", () => {
    expect(() => parseDbArgs(["execute", "SELECT 1", "--file", "query.sql"])).toThrow(
      "Error: Provide either SQL inline or --file, not both",
    );
  });

  it("parses migrate", () => {
    expect(parseDbArgs(["migrate"])).toEqual({ action: "migrate" });
  });

  it("errors on migrate with extra positional", () => {
    expect(() => parseDbArgs(["migrate", "extra"])).toThrow("Error: Unexpected argument: extra");
  });

  it("parses push", () => {
    expect(parseDbArgs(["push"])).toEqual({ action: "push" });
  });

  it("errors on push with extra positional", () => {
    expect(() => parseDbArgs(["push", "extra"])).toThrow("Error: Unexpected argument: extra");
  });

  it("parses generate", () => {
    expect(parseDbArgs(["generate"])).toEqual({ action: "generate" });
  });

  it("errors on generate with extra positional", () => {
    expect(() => parseDbArgs(["generate", "extra"])).toThrow("Error: Unexpected argument: extra");
  });

  it("parses export with no flags", () => {
    expect(parseDbArgs(["export"])).toEqual({
      action: "export",
      output: undefined,
      noData: undefined,
      noSchema: undefined,
      table: undefined,
    });
  });

  it("parses export with --output", () => {
    expect(parseDbArgs(["export", "--output", "backup.sql"])).toEqual({
      action: "export",
      output: "backup.sql",
      noData: undefined,
      noSchema: undefined,
      table: undefined,
    });
  });

  it("parses export with --no-data", () => {
    expect(parseDbArgs(["export", "--no-data"])).toEqual({
      action: "export",
      output: undefined,
      noData: true,
      noSchema: undefined,
      table: undefined,
    });
  });

  it("parses export with --no-schema", () => {
    expect(parseDbArgs(["export", "--no-schema"])).toEqual({
      action: "export",
      output: undefined,
      noData: undefined,
      noSchema: true,
      table: undefined,
    });
  });

  it("parses export with --table", () => {
    expect(parseDbArgs(["export", "--table", "users"])).toEqual({
      action: "export",
      output: undefined,
      noData: undefined,
      noSchema: undefined,
      table: "users",
    });
  });

  it("parses export with all flags", () => {
    expect(
      parseDbArgs(["export", "--output", "dump.sql", "--no-data", "--table", "users"]),
    ).toEqual({
      action: "export",
      output: "dump.sql",
      noData: true,
      noSchema: undefined,
      table: "users",
    });
  });

  it("errors on export with extra positional", () => {
    expect(() => parseDbArgs(["export", "extra"])).toThrow("Error: Unexpected argument: extra");
  });

  it("parses studio", () => {
    expect(parseDbArgs(["studio"])).toEqual({ action: "studio" });
  });

  it("errors on studio with extra positional", () => {
    expect(() => parseDbArgs(["studio", "extra"])).toThrow("Error: Unexpected argument: extra");
  });

  it("errors on unknown subcommand", () => {
    expect(() => parseDbArgs(["unknown"])).toThrow(
      "Error: Usage: void db <push|generate|status|reset|seed|execute|migrate|studio|export|set-url>",
    );
  });

  it("errors on no subcommand", () => {
    expect(() => parseDbArgs([])).toThrow(
      "Error: Usage: void db <push|generate|status|reset|seed|execute|migrate|studio|export|set-url>",
    );
  });

  it("errors on extra positional", () => {
    expect(() => parseDbArgs(["status", "extra"])).toThrow("Error: Unexpected argument: extra");
  });
});
