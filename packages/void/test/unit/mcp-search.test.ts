import { describe, it, expect } from "vitest";

import { searchDocs } from "../../src/cli/mcp";

interface DocPage {
  slug: string;
  title: string;
  content: string;
}

const pages: DocPage[] = [
  {
    slug: "routing",
    title: "File System Routing",
    content:
      "Drop files in routes/ and they become endpoints. Each route file exports HTTP methods like GET and POST.",
  },
  {
    slug: "db",
    title: "Database",
    content:
      "Use the db query client for typed D1 queries. Supports list, get, insert, update, delete.",
  },
  {
    slug: "auth",
    title: "Authentication",
    content:
      "Built-in auth with email/password, GitHub OAuth, and Google OAuth. Sessions stored in KV.",
  },
  {
    slug: "quickstart",
    title: "Quickstart",
    content: "Get started with Void in minutes. Install void and add the plugin to your config.",
  },
  {
    slug: "config",
    title: "Configuration",
    content: "All settings live in void.json. Configure bindings, auth, headers, and mode.",
  },
  {
    slug: "kv",
    title: "KV Storage",
    content:
      "Key-value storage powered by Cloudflare KV. Import kv from void and use get/set/delete.",
  },
];

describe("searchDocs", () => {
  it("returns empty array for empty query", () => {
    expect(searchDocs(pages, "")).toEqual([]);
  });

  it("returns empty array for whitespace-only query", () => {
    expect(searchDocs(pages, "   ")).toEqual([]);
  });

  it("returns empty array when no pages match", () => {
    expect(searchDocs(pages, "zzzznotfound")).toEqual([]);
  });

  it("finds pages by content match", () => {
    const results = searchDocs(pages, "OAuth");
    expect(results.length).toBe(1);
    expect(results[0].slug).toBe("auth");
  });

  it("weights title matches higher than content", () => {
    const results = searchDocs(pages, "routing");
    expect(results[0].slug).toBe("routing");
  });

  it("is case-insensitive", () => {
    const results = searchDocs(pages, "DATABASE");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].slug).toBe("db");
  });

  it("handles multi-word queries", () => {
    const results = searchDocs(pages, "file routing");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.slug === "routing")).toBe(true);
  });

  it("returns at most 5 results", () => {
    const manyPages: DocPage[] = Array.from({ length: 10 }, (_, i) => ({
      slug: `page-${i}`,
      title: `Page ${i}`,
      content: `This page contains the common term.`,
    }));
    const results = searchDocs(manyPages, "common");
    expect(results.length).toBe(5);
  });

  it("sorts results by score descending", () => {
    const results = searchDocs(pages, "auth");
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("includes snippet with context around match", () => {
    const results = searchDocs(pages, "OAuth");
    expect(results[0].snippet).toContain("OAuth");
  });

  it("adds ellipsis prefix when snippet starts mid-content", () => {
    const longPage: DocPage[] = [
      {
        slug: "long",
        title: "Long Page",
        content: "A".repeat(200) + " target word here " + "B".repeat(200),
      },
    ];
    const results = searchDocs(longPage, "target");
    expect(results[0].snippet.startsWith("...")).toBe(true);
  });

  it("adds ellipsis suffix when snippet ends before content end", () => {
    const longPage: DocPage[] = [
      {
        slug: "long",
        title: "Long Page",
        content: "target word here " + "B".repeat(200),
      },
    ];
    const results = searchDocs(longPage, "target");
    expect(results[0].snippet.endsWith("...")).toBe(true);
  });

  it("counts multiple occurrences of a term", () => {
    const repeatingPages: DocPage[] = [
      { slug: "few", title: "Few", content: "route" },
      { slug: "many", title: "Many", content: "route route route route route" },
    ];
    const results = searchDocs(repeatingPages, "route");
    expect(results[0].slug).toBe("many");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });
});
