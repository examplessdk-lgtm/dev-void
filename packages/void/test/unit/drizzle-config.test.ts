import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeDrizzleConfig } from "../../src/drizzle/config";

describe("writeDrizzleConfig", () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `void-drizzle-cfg-${Date.now()}`);
    mkdirSync(join(root, ".void"), { recursive: true });
    mkdirSync(join(root, "db"), { recursive: true });
    writeFileSync(join(root, "db/schema.ts"), "export const users = {};");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writes a valid JSON config to .void/", () => {
    const configPath = writeDrizzleConfig(root, "/tmp/test.sqlite");
    expect(configPath).toBe(join(root, ".void", "drizzle.config.json"));
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.dialect).toBe("sqlite");
    expect(config.schema).toBe("./db/schema.ts");
    expect(config.out).toBe("./db/migrations");
    expect(config.dbCredentials.url).toBe("/tmp/test.sqlite");
  });
});
