import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { scanPages, resolveLayoutChain, MAX_REVALIDATE } from "../../src/pages/scan";

const TMP = join(import.meta.dirname, "__tmp_pages_scan__");

function writeFile(relativePath: string, content: string): void {
  const full = join(TMP, "pages", relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

describe("scanPages", () => {
  beforeEach(() => {
    mkdirSync(join(TMP, "pages"), { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("returns empty result when no pages/ directory exists", async () => {
    rmSync(join(TMP, "pages"), { recursive: true, force: true });
    const result = await scanPages(TMP);
    expect(result).toEqual({ pages: [], layouts: [] });
  });

  it("scans .vue files and produces correct patterns", async () => {
    writeFile("index.vue", "<template><div>Home</div></template>");
    writeFile("about.vue", "<template><div>About</div></template>");
    writeFile("users/index.vue", "<template><div>Users</div></template>");
    writeFile("users/[id].vue", "<template><div>User</div></template>");

    const result = await scanPages(TMP);

    expect(result.pages).toHaveLength(4);

    const home = result.pages.find((p) => p.componentId === "index");
    expect(home).toBeDefined();
    expect(home!.pattern).toBe("/");

    const about = result.pages.find((p) => p.componentId === "about");
    expect(about).toBeDefined();
    expect(about!.pattern).toBe("/about");

    const users = result.pages.find((p) => p.componentId === "users");
    expect(users).toBeDefined();
    expect(users!.pattern).toBe("/users");

    const userId = result.pages.find((p) => p.componentId === "users/[id]");
    expect(userId).toBeDefined();
    expect(userId!.pattern).toBe("/users/:id");
    expect(userId!.params).toEqual(["id"]);
  });

  it("detects companion .server.ts files and extracts methods", async () => {
    writeFile("users/index.vue", "<template><div>Users</div></template>");
    writeFile(
      "users/index.server.ts",
      "export const loader = () => [];\nexport const action = () => ({});",
    );

    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === "users");
    expect(page).toBeDefined();
    expect(page!.serverPath).toBe("users/index.server.ts");
    expect(page!.methods).toEqual(["loader", "action"]);
  });

  it("identifies layout.vue files separately", async () => {
    writeFile("layout.vue", "<template><slot /></template>");
    writeFile("users/layout.vue", "<template><slot /></template>");
    writeFile("index.vue", "<template><div>Home</div></template>");

    const result = await scanPages(TMP);
    expect(result.layouts).toHaveLength(2);

    const root = result.layouts.find((l) => l.directory === "");
    expect(root).toBeDefined();
    expect(root!.filePath).toBe("layout.vue");

    const users = result.layouts.find((l) => l.directory === "users");
    expect(users).toBeDefined();
    expect(users!.filePath).toBe("users/layout.vue");

    // Layouts should not appear as pages
    expect(result.pages.every((p) => !p.componentPath.includes("layout"))).toBe(true);
  });

  it("skips _-prefixed files", async () => {
    writeFile("index.vue", "<template><div>Home</div></template>");
    writeFile("_components/shared.vue", "<template><div>Shared</div></template>");
    writeFile("_hidden.vue", "<template><div>Hidden</div></template>");

    const result = await scanPages(TMP);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].componentId).toBe("index");
  });

  it("sorts static before dynamic, catch-all last", async () => {
    writeFile("about.vue", "<template><div /></template>");
    writeFile("[...slug].vue", "<template><div /></template>");
    writeFile("[id].vue", "<template><div /></template>");
    writeFile("index.vue", "<template><div /></template>");

    const result = await scanPages(TMP);
    const patterns = result.pages.map((p) => p.pattern);
    // Static routes first (/about, /), then dynamic (/:id), then catch-all
    expect(patterns.indexOf("/about")).toBeLessThan(patterns.indexOf("/:id"));
    expect(patterns.indexOf("/:id")).toBeLessThan(patterns.indexOf("/**:slug"));
  });

  it("handles .tsx components", async () => {
    writeFile("dashboard.tsx", "export default function Dashboard() { return <div />; }");
    const result = await scanPages(TMP);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].componentId).toBe("dashboard");
    expect(result.pages[0].pattern).toBe("/dashboard");
  });

  it("extracts revalidate from .server.ts", async () => {
    writeFile("products/index.vue", "<template><div>Products</div></template>");
    writeFile(
      "products/index.server.ts",
      "export const revalidate = 120;\nexport const loader = () => [];",
    );

    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === "products");
    expect(page).toBeDefined();
    expect(page!.revalidate).toBe(120);
  });

  it("extracts revalidate zero from .server.ts", async () => {
    writeFile("private.vue", "<template><div>Private</div></template>");
    writeFile("private.server.ts", "export const revalidate = 0;\nexport const loader = () => [];");

    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === "private");
    expect(page).toBeDefined();
    expect(page!.revalidate).toBe(0);
  });

  it("returns undefined revalidate when not exported", async () => {
    writeFile("about.vue", "<template><div>About</div></template>");
    writeFile("about.server.ts", "export const loader = () => [];");

    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === "about");
    expect(page).toBeDefined();
    expect(page!.revalidate).toBeUndefined();
  });

  it("detects prerender = true from .server.ts", async () => {
    writeFile("products/index.vue", "<template><div>Products</div></template>");
    writeFile(
      "products/index.server.ts",
      "export const prerender = true;\nexport const loader = () => [];",
    );

    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === "products");
    expect(page).toBeDefined();
    expect(page!.prerender).toBe(true);
  });

  it("detects getPrerenderPaths from .server.ts", async () => {
    writeFile("blog/[slug].vue", "<template><div>Blog</div></template>");
    writeFile(
      "blog/[slug].server.ts",
      "export const prerender = true;\nexport async function getPrerenderPaths() { return [{ slug: 'hello' }]; }\nexport const loader = () => [];",
    );

    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === "blog/[slug]");
    expect(page).toBeDefined();
    expect(page!.prerender).toBe(true);
    expect(page!.hasGetPrerenderPaths).toBe(true);
  });

  it("scans .island.tsx files with island flag", async () => {
    writeFile("index.island.tsx", "export default function Home() { return <div />; }");
    const result = await scanPages(TMP);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].island).toBe(true);
    expect(result.pages[0].componentId).toBe("index");
    expect(result.pages[0].pattern).toBe("/");
  });

  it("scans .island.vue files with island flag", async () => {
    writeFile("pricing.island.vue", "<template><div>Pricing</div></template>");
    const result = await scanPages(TMP);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].island).toBe(true);
    expect(result.pages[0].componentId).toBe("pricing");
    expect(result.pages[0].pattern).toBe("/pricing");
  });

  it("detects layout.island.tsx as island layout", async () => {
    writeFile(
      "blog/layout.island.tsx",
      "export default function Layout({ children }) { return <div>{children}</div>; }",
    );
    writeFile("blog/index.island.tsx", "export default function Blog() { return <div />; }");
    const result = await scanPages(TMP);
    expect(result.layouts).toHaveLength(1);
    expect(result.layouts[0].island).toBe(true);
    expect(result.layouts[0].directory).toBe("blog");
  });

  it("finds companion .server.ts for island pages", async () => {
    writeFile("index.island.tsx", "export default function Home() { return <div />; }");
    writeFile("index.server.ts", "export const loader = () => ({});");
    const result = await scanPages(TMP);
    expect(result.pages[0].island).toBe(true);
    expect(result.pages[0].serverPath).toBe("index.server.ts");
  });

  it("throws when regular page is under island layout", async () => {
    writeFile(
      "blog/layout.island.tsx",
      "export default function L({ children }) { return children; }",
    );
    writeFile("blog/post.tsx", "export default function Post() { return <div />; }");

    await expect(scanPages(TMP)).rejects.toThrow("Regular page");
  });

  it("throws when regular index page is under island layout", async () => {
    writeFile(
      "blog/layout.island.tsx",
      "export default function L({ children }) { return children; }",
    );
    writeFile("blog/index.tsx", "export default function Blog() { return <div />; }");

    await expect(scanPages(TMP)).rejects.toThrow("Regular page");
  });

  it("non-island pages have island as undefined", async () => {
    writeFile("dashboard.tsx", "export default function Dashboard() { return <div />; }");
    const result = await scanPages(TMP);
    expect(result.pages[0].island).toBeUndefined();
  });

  it("returns undefined prerender when not exported", async () => {
    writeFile("about.vue", "<template><div>About</div></template>");
    writeFile("about.server.ts", "export const loader = () => [];");

    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === "about");
    expect(page).toBeDefined();
    expect(page!.prerender).toBeUndefined();
    expect(page!.hasGetPrerenderPaths).toBeUndefined();
  });

  it("auto-prerenders static island page with no loader, no params", async () => {
    writeFile("pricing.island.vue", "<template><div>Pricing</div></template>");
    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === "pricing");
    expect(page!.prerender).toBe(true);
    expect(page!.revalidate).toBe(MAX_REVALIDATE);
  });

  it("auto-prerenders island page even with island imports", async () => {
    writeFile(
      "pricing.island.vue",
      `<script setup>\nimport Counter from "./Counter.vue" with { island: "load" };\n</script>\n<template><Counter /></template>`,
    );
    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === "pricing");
    expect(page!.prerender).toBe(true);
    expect(page!.revalidate).toBe(MAX_REVALIDATE);
  });

  it("does not auto-prerender island page with loader", async () => {
    writeFile("products.island.vue", "<template><div>Products</div></template>");
    writeFile("products.server.ts", "export const loader = () => [];");
    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === "products");
    expect(page!.prerender).toBeUndefined();
  });

  it("does not auto-prerender dynamic island page", async () => {
    writeFile("blog/[slug].island.vue", "<template><div>Post</div></template>");
    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === "blog/[slug]");
    expect(page!.prerender).toBeUndefined();
  });

  it("auto-sets max revalidate for explicit prerender on any page", async () => {
    writeFile("about.vue", "<template><div>About</div></template>");
    writeFile("about.server.ts", "export const prerender = true;");
    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === "about");
    expect(page!.prerender).toBe(true);
    expect(page!.revalidate).toBe(MAX_REVALIDATE);
  });

  it("preserves explicit revalidate when prerender is true", async () => {
    writeFile("about.vue", "<template><div>About</div></template>");
    writeFile("about.server.ts", "export const prerender = true;\nexport const revalidate = 3600;");
    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === "about");
    expect(page!.prerender).toBe(true);
    expect(page!.revalidate).toBe(3600);
  });

  it("auto-prerenders island page but preserves user revalidate from server file", async () => {
    writeFile("pricing.island.vue", "<template><div>Pricing</div></template>");
    writeFile("pricing.server.ts", "export const revalidate = 60;");
    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === "pricing");
    expect(page!.prerender).toBe(true);
    expect(page!.revalidate).toBe(60);
  });
});

describe("resolveLayoutChain", () => {
  it("returns correct layout hierarchy", () => {
    const layouts = [
      { directory: "", filePath: "layout.vue" },
      { directory: "users", filePath: "users/layout.vue" },
      { directory: "users/settings", filePath: "users/settings/layout.vue" },
    ];

    const chain = resolveLayoutChain("users/settings/profile", layouts);
    expect(chain).toHaveLength(3);
    expect(chain[0].directory).toBe("");
    expect(chain[1].directory).toBe("users");
    expect(chain[2].directory).toBe("users/settings");
  });

  it("returns only root layout for top-level pages", () => {
    const layouts = [
      { directory: "", filePath: "layout.vue" },
      { directory: "users", filePath: "users/layout.vue" },
    ];

    const chain = resolveLayoutChain("about", layouts);
    expect(chain).toHaveLength(1);
    expect(chain[0].directory).toBe("");
  });

  it("returns empty array when no layouts match", () => {
    const layouts = [{ directory: "admin", filePath: "admin/layout.vue" }];

    const chain = resolveLayoutChain("about", layouts);
    expect(chain).toHaveLength(0);
  });

  it("skips missing intermediate layouts", () => {
    const layouts = [
      { directory: "", filePath: "layout.vue" },
      { directory: "users/settings", filePath: "users/settings/layout.vue" },
    ];

    const chain = resolveLayoutChain("users/settings/profile", layouts);
    expect(chain).toHaveLength(2);
    expect(chain[0].directory).toBe("");
    expect(chain[1].directory).toBe("users/settings");
  });
});
