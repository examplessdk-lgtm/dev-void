import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mockSsrLoadModule = vi.fn();
const mockClose = vi.fn();

vi.mock("vite", () => ({
  createServer: vi.fn(() =>
    Promise.resolve({
      ssrLoadModule: mockSsrLoadModule,
      close: mockClose,
    }),
  ),
}));

// Dynamically import after mocks are set up
const { collectPrerenderPaths } = await import("../../src/prerender-paths");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "void-prerender-paths-"));
  mkdirSync(join(root, "pages"), { recursive: true });
  mockSsrLoadModule.mockReset();
  mockClose.mockReset();
  mockClose.mockResolvedValue(undefined);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("collectPrerenderPaths", () => {
  it("throws when getPrerenderPaths() rejects", async () => {
    // Create a dynamic page with prerender=true and getPrerenderPaths
    writeFileSync(
      join(root, "pages", "[slug].server.ts"),
      "export const prerender = true;\nexport function getPrerenderPaths() { return []; }\nexport const loader = () => ({});",
    );
    writeFileSync(join(root, "pages", "[slug].vue"), "<template><div/></template>");

    const cause = new Error("DB connection failed");
    mockSsrLoadModule.mockResolvedValue({
      getPrerenderPaths: () => Promise.reject(cause),
    });

    await expect(collectPrerenderPaths({ root, config: {} })).rejects.toThrow(
      "[void] Failed to resolve prerender paths for /:slug",
    );

    // Verify the original error is preserved as the cause
    try {
      await collectPrerenderPaths({ root, config: {} });
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).cause).toBe(cause);
    }
  });

  it("throws when ssrLoadModule() fails for a dynamic prerender page", async () => {
    writeFileSync(
      join(root, "pages", "[id].server.ts"),
      "export const prerender = true;\nexport function getPrerenderPaths() { return []; }\nexport const loader = () => ({});",
    );
    writeFileSync(join(root, "pages", "[id].vue"), "<template><div/></template>");

    const cause = new Error("Module not found");
    mockSsrLoadModule.mockRejectedValue(cause);

    await expect(collectPrerenderPaths({ root, config: {} })).rejects.toThrow(
      "[void] Failed to resolve prerender paths for /:id: Module not found",
    );
  });

  it("closes the vite server even when getPrerenderPaths throws", async () => {
    writeFileSync(
      join(root, "pages", "[slug].server.ts"),
      "export const prerender = true;\nexport function getPrerenderPaths() { return []; }\nexport const loader = () => ({});",
    );
    writeFileSync(join(root, "pages", "[slug].vue"), "<template><div/></template>");

    mockSsrLoadModule.mockResolvedValue({
      getPrerenderPaths: () => Promise.reject(new Error("boom")),
    });

    await expect(collectPrerenderPaths({ root, config: {} })).rejects.toThrow(
      "[void] Failed to resolve prerender paths",
    );

    expect(mockClose).toHaveBeenCalled();
  });
});
