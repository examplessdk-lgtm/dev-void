import { describe, expect, it } from "vitest";

import { parseGenArgs } from "../../src/cli/gen-args";

describe("parseGenArgs", () => {
  it("errors on no subcommand", () => {
    expect(() => parseGenArgs([])).toThrow(
      "Error: Usage: void gen <model|migration|route|middleware|ssr|cron|queue>",
    );
  });

  it("errors on unknown subcommand", () => {
    expect(() => parseGenArgs(["unknown"])).toThrow(
      "Error: Usage: void gen <model|migration|route|middleware|ssr|cron|queue>",
    );
  });

  describe("model", () => {
    it("parses model with no columns", () => {
      expect(parseGenArgs(["model", "posts"])).toEqual({
        subcommand: "model",
        name: "posts",
        columns: [],
      });
    });

    it("parses model with columns", () => {
      expect(
        parseGenArgs(["model", "posts", "title:string", "body:text", "views:integer"]),
      ).toEqual({
        subcommand: "model",
        name: "posts",
        columns: [
          { name: "title", type: "string", nullable: false },
          { name: "body", type: "text", nullable: false },
          { name: "views", type: "integer", nullable: false },
        ],
      });
    });

    it("parses nullable columns", () => {
      expect(parseGenArgs(["model", "posts", "bio:text?"])).toEqual({
        subcommand: "model",
        name: "posts",
        columns: [{ name: "bio", type: "text", nullable: true }],
      });
    });

    it("supports all column types", () => {
      const types = ["string", "text", "datetime", "integer", "boolean", "real", "blob"];
      for (const type of types) {
        const result = parseGenArgs(["model", "t", `col:${type}`]);
        expect(result).toEqual({
          subcommand: "model",
          name: "t",
          columns: [{ name: "col", type, nullable: false }],
        });
      }
    });

    it("errors on missing name", () => {
      expect(() => parseGenArgs(["model"])).toThrow("Error: Usage: void gen model <name>");
    });

    it("errors on invalid model name", () => {
      expect(() => parseGenArgs(["model", "1bad"])).toThrow(
        "Error: Model name must be lowercase alphanumeric",
      );
    });

    it("errors on uppercase model name", () => {
      expect(() => parseGenArgs(["model", "Posts"])).toThrow(
        "Error: Model name must be lowercase alphanumeric",
      );
    });

    it("errors on invalid column format", () => {
      expect(() => parseGenArgs(["model", "posts", "bad"])).toThrow(
        "Error: Invalid column format: bad",
      );
    });

    it("errors on unknown column type", () => {
      expect(() => parseGenArgs(["model", "posts", "col:varchar"])).toThrow(
        "Error: Unknown column type: varchar",
      );
    });
  });

  describe("migration", () => {
    it("parses migration name", () => {
      expect(parseGenArgs(["migration", "add_avatar_to_users"])).toEqual({
        subcommand: "migration",
        name: "add_avatar_to_users",
      });
    });

    it("errors on missing name", () => {
      expect(() => parseGenArgs(["migration"])).toThrow("Error: Usage: void gen migration <name>");
    });

    it("errors on extra argument", () => {
      expect(() => parseGenArgs(["migration", "foo", "bar"])).toThrow(
        "Error: Unexpected argument: bar",
      );
    });

    it("errors on invalid name", () => {
      expect(() => parseGenArgs(["migration", "1bad"])).toThrow(
        "Error: Migration name must be lowercase alphanumeric",
      );
    });
  });

  describe("route", () => {
    it("parses route with default GET method", () => {
      expect(parseGenArgs(["route", "api/health"])).toEqual({
        subcommand: "route",
        path: "api/health",
        methods: ["get"],
      });
    });

    it("parses route with explicit methods", () => {
      expect(parseGenArgs(["route", "api/users", "--methods", "get,post"])).toEqual({
        subcommand: "route",
        path: "api/users",
        methods: ["get", "post"],
      });
    });

    it("strips leading slashes", () => {
      expect(parseGenArgs(["route", "/api/health"])).toEqual({
        subcommand: "route",
        path: "api/health",
        methods: ["get"],
      });
    });

    it("errors on missing path", () => {
      expect(() => parseGenArgs(["route"])).toThrow("Error: Usage: void gen route <path>");
    });

    it("errors on extra argument", () => {
      expect(() => parseGenArgs(["route", "api/foo", "bar"])).toThrow(
        "Error: Unexpected argument: bar",
      );
    });

    it("errors on unknown HTTP method", () => {
      expect(() => parseGenArgs(["route", "api/foo", "--methods", "get,head"])).toThrow(
        "Error: Unknown HTTP method: head",
      );
    });
  });

  describe("middleware", () => {
    it("parses middleware name", () => {
      expect(parseGenArgs(["middleware", "auth"])).toEqual({
        subcommand: "middleware",
        name: "auth",
      });
    });

    it("errors on missing name", () => {
      expect(() => parseGenArgs(["middleware"])).toThrow(
        "Error: Usage: void gen middleware <name>",
      );
    });

    it("errors on extra argument", () => {
      expect(() => parseGenArgs(["middleware", "auth", "extra"])).toThrow(
        "Error: Unexpected argument: extra",
      );
    });
  });

  describe("ssr", () => {
    it("parses ssr with no framework (auto-detect)", () => {
      expect(parseGenArgs(["ssr"])).toEqual({
        subcommand: "ssr",
        framework: undefined,
      });
    });

    it("parses ssr with --react", () => {
      expect(parseGenArgs(["ssr", "--react"])).toEqual({
        subcommand: "ssr",
        framework: "react",
      });
    });

    it("parses ssr with --vue", () => {
      expect(parseGenArgs(["ssr", "--vue"])).toEqual({
        subcommand: "ssr",
        framework: "vue",
      });
    });

    it("parses ssr with --svelte", () => {
      expect(parseGenArgs(["ssr", "--svelte"])).toEqual({
        subcommand: "ssr",
        framework: "svelte",
      });
    });

    it("parses ssr with --solid", () => {
      expect(parseGenArgs(["ssr", "--solid"])).toEqual({
        subcommand: "ssr",
        framework: "solid",
      });
    });

    it("errors on multiple framework flags", () => {
      expect(() => parseGenArgs(["ssr", "--react", "--vue"])).toThrow(
        "Error: Only one framework flag can be specified.",
      );
    });

    it("errors on unexpected positional", () => {
      expect(() => parseGenArgs(["ssr", "extra"])).toThrow("Error: Unexpected argument: extra");
    });
  });

  describe("cron", () => {
    it("parses cron name", () => {
      expect(parseGenArgs(["cron", "hourly-sync"])).toEqual({
        subcommand: "cron",
        name: "hourly-sync",
      });
    });

    it("errors on missing name", () => {
      expect(() => parseGenArgs(["cron"])).toThrow("Error: Usage: void gen cron <name>");
    });

    it("errors on extra argument", () => {
      expect(() => parseGenArgs(["cron", "sync", "extra"])).toThrow(
        "Error: Unexpected argument: extra",
      );
    });

    it("errors on invalid name", () => {
      expect(() => parseGenArgs(["cron", "1bad"])).toThrow(
        "Error: Cron name must be lowercase alphanumeric",
      );
    });

    it("allows hyphens in name", () => {
      expect(parseGenArgs(["cron", "daily-report"])).toEqual({
        subcommand: "cron",
        name: "daily-report",
      });
    });
  });

  describe("queue", () => {
    it("parses queue name", () => {
      expect(parseGenArgs(["queue", "emails"])).toEqual({
        subcommand: "queue",
        name: "emails",
      });
    });

    it("errors on missing name", () => {
      expect(() => parseGenArgs(["queue"])).toThrow("Error: Usage: void gen queue <name>");
    });

    it("errors on extra argument", () => {
      expect(() => parseGenArgs(["queue", "emails", "extra"])).toThrow(
        "Error: Unexpected argument: extra",
      );
    });

    it("errors on invalid name", () => {
      expect(() => parseGenArgs(["queue", "1bad"])).toThrow(
        "Error: Queue name must be lowercase alphanumeric",
      );
    });

    it("allows hyphens in name", () => {
      expect(parseGenArgs(["queue", "order-notifications"])).toEqual({
        subcommand: "queue",
        name: "order-notifications",
      });
    });
  });
});
