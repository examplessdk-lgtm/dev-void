import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempHomes: string[] = [];

function setIsolatedHome(): void {
  const dir = mkdtempSync(join(tmpdir(), "void-home-"));
  tempHomes.push(dir);
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
}

async function importRunProjectsCommand() {
  vi.resetModules();
  const mod = await import("../../src/cli/projects");
  return mod.runProjectsCommand;
}

function captureOutput(): { output: () => string; restore: () => void } {
  const chunks: string[] = [];
  const writeMock = vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
    const chunk = args[0];
    if (typeof chunk === "string") {
      chunks.push(chunk);
    } else if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk.toString());
    }
    return true;
  });
  const logMock = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    chunks.push(args.map(String).join(" ") + "\n");
  });
  return {
    output: () => chunks.join(""),
    restore: () => {
      writeMock.mockRestore();
      logMock.mockRestore();
    },
  };
}

describe("runProjectsCommand", () => {
  afterEach(() => {
    delete process.env.VOID_TOKEN;
    delete process.env.VOID_API_URL;

    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    while (tempHomes.length > 0) {
      const dir = tempHomes.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints projects for the authenticated user", async () => {
    setIsolatedHome();
    process.env.VOID_TOKEN = "test-token";
    process.env.VOID_API_URL = "https://api.example.test";

    const fetchMock = vi.fn(async () =>
      Response.json([
        {
          id: "proj_1",
          user_id: "user_1",
          slug: "star-tracker",
          created_at: "2026-02-15T00:00:00.000Z",
        },
        {
          id: "proj_2",
          user_id: "user_1",
          slug: "todo-app",
          created_at: "2026-02-15T00:00:00.000Z",
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const capture = captureOutput();
    const runProjectsCommand = await importRunProjectsCommand();
    await runProjectsCommand();
    const out = capture.output();
    capture.restore();

    expect(fetchMock).toHaveBeenCalledWith("https://api.example.test/projects", {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(out).toContain("star-tracker");
    expect(out).toContain("https://star-tracker.staging.void.app");
    expect(out).toContain("todo-app");
    expect(out).toContain("https://todo-app.staging.void.app");
  });

  it("prints a friendly message when there are no projects", async () => {
    setIsolatedHome();
    process.env.VOID_TOKEN = "test-token";
    process.env.VOID_API_URL = "https://api.example.test";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([])),
    );

    const capture = captureOutput();
    const runProjectsCommand = await importRunProjectsCommand();
    await runProjectsCommand();
    const out = capture.output();
    capture.restore();

    expect(out).toContain("No projects found.");
  });

  it("exits with error when not logged in", async () => {
    setIsolatedHome();

    const capture = captureOutput();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);

    const runProjectsCommand = await importRunProjectsCommand();
    await expect(runProjectsCommand()).rejects.toThrow("process.exit:1");
    const out = capture.output();
    capture.restore();

    expect(out).toContain("Not logged in");
    expect(exitSpy).toHaveBeenCalled();
  });
});
