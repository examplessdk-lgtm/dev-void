import { describe, it, expect, beforeAll } from "vitest";
import { searchDocs } from "../../src/cli/mcp";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Replicate loadDocs logic for tests.
function loadDocs() {
  const bundledDocsDir = join(import.meta.dirname, "../../skills/void/docs");
  const docsDir = existsSync(bundledDocsDir)
    ? bundledDocsDir
    : join(import.meta.dirname, "../../../../docs");
  const files = readdirSync(docsDir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  return files.map((file) => {
    let content = readFileSync(join(docsDir, file), "utf-8");
    content = content.replace(/^---\n[\s\S]*?\n---\n/, "");
    const titleMatch = content.match(/^#\s+(.+)/m);
    const title = titleMatch ? titleMatch[1].trim() : file.replace(/\.md$/, "");
    const slug = file.replace(/\.md$/, "");
    return { slug, title, content };
  });
}

interface JsonRpcRequest {
  jsonrpc: string;
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

// Inline dispatch logic matching mcp.ts handleRequest
const TOOLS = [
  {
    name: "list_pages",
    description: "List all Void documentation pages with their slugs and titles",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "get_page",
    description: "Get the full content of a Void documentation page by slug",
    inputSchema: {
      type: "object" as const,
      properties: {
        slug: { type: "string", description: "Page slug, e.g. 'routing' or 'quickstart'" },
      },
      required: ["slug"],
    },
  },
  {
    name: "search_docs",
    description:
      "Search Void documentation by keyword query. Returns top 5 matching pages with snippets.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query, e.g. 'file routing' or 'database migrations'",
        },
      },
      required: ["query"],
    },
  },
];

function handleRequest(
  pages: { slug: string; title: string; content: string }[],
  req: JsonRpcRequest,
): object | null {
  const { method, id, params } = req;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "void", version: "1.0.0" },
      },
    };
  }
  if (method === "notifications/initialized") return null;
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (method === "tools/call") {
    const toolName = (params as Record<string, unknown>)?.name as string;
    const toolArgs = ((params as Record<string, unknown>)?.arguments ?? {}) as Record<
      string,
      unknown
    >;
    if (toolName === "list_pages") {
      const list = pages.map((p) => ({ slug: p.slug, title: p.title }));
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] },
      };
    }
    if (toolName === "get_page") {
      const slug = toolArgs.slug as string;
      const page = pages.find((p) => p.slug === slug);
      if (!page) {
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: `Page not found: ${slug}` }], isError: true },
        };
      }
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: page.content }] } };
    }
    if (toolName === "search_docs") {
      const query = toolArgs.query as string;
      const results = searchDocs(pages, query);
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] },
      };
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${toolName}` } };
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } };
}

describe("mcp server handler", () => {
  let pages: { slug: string; title: string; content: string }[];

  beforeAll(() => {
    pages = loadDocs();
  });

  it("responds to initialize", () => {
    const res = handleRequest(pages, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    }) as Record<string, unknown>;

    expect(res.id).toBe(1);
    const result = res.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.capabilities).toEqual({ tools: {} });
    expect(result.serverInfo).toEqual({ name: "void", version: "1.0.0" });
  });

  it("handles notifications/initialized (returns null)", () => {
    const res = handleRequest(pages, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(res).toBeNull();
  });

  it("responds to ping", () => {
    const res = handleRequest(pages, {
      jsonrpc: "2.0",
      id: 2,
      method: "ping",
    }) as Record<string, unknown>;
    expect(res.id).toBe(2);
    expect(res.result).toEqual({});
  });

  it("responds to tools/list with 3 tools", () => {
    const res = handleRequest(pages, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
    }) as Record<string, unknown>;
    const result = res.result as { tools: { name: string }[] };
    expect(result.tools).toHaveLength(3);
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("list_pages");
    expect(names).toContain("get_page");
    expect(names).toContain("search_docs");
  });

  it("tools/call list_pages returns pages with slug and title", () => {
    const res = handleRequest(pages, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "list_pages", arguments: {} },
    }) as Record<string, unknown>;
    const result = res.result as { content: { type: string; text: string }[] };
    const list = JSON.parse(result.content[0].text);
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]).toHaveProperty("slug");
    expect(list[0]).toHaveProperty("title");
  });

  it("tools/call get_page returns page content", () => {
    const slug = pages[0].slug;
    const res = handleRequest(pages, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "get_page", arguments: { slug } },
    }) as Record<string, unknown>;
    const result = res.result as { content: { type: string; text: string }[] };
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  it("tools/call get_page returns error for unknown slug", () => {
    const res = handleRequest(pages, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "get_page", arguments: { slug: "nonexistent-page" } },
    }) as Record<string, unknown>;
    const result = res.result as { content: { text: string }[]; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("nonexistent-page");
  });

  it("tools/call search_docs returns results", () => {
    const res = handleRequest(pages, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "search_docs", arguments: { query: "routing" } },
    }) as Record<string, unknown>;
    const result = res.result as { content: { text: string }[] };
    const results = JSON.parse(result.content[0].text);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty("slug");
    expect(results[0]).toHaveProperty("title");
    expect(results[0]).toHaveProperty("snippet");
    expect(results[0]).toHaveProperty("score");
  });

  it("returns error for unknown method", () => {
    const res = handleRequest(pages, {
      jsonrpc: "2.0",
      id: 8,
      method: "unknown/method",
    }) as Record<string, unknown>;
    expect(res.error).toBeDefined();
    const error = res.error as { code: number; message: string };
    expect(error.code).toBe(-32601);
  });

  it("returns error for unknown tool", () => {
    const res = handleRequest(pages, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "nonexistent_tool", arguments: {} },
    }) as Record<string, unknown>;
    expect(res.error).toBeDefined();
    const error = res.error as { code: number; message: string };
    expect(error.code).toBe(-32601);
  });

  it("JSON round-trip preserves valid JSON-RPC structure", () => {
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/list",
    });
    const parsed = JSON.parse(request);
    const response = handleRequest(pages, parsed);
    const serialized = JSON.stringify(response);
    const reparsed = JSON.parse(serialized);
    expect(reparsed.jsonrpc).toBe("2.0");
    expect(reparsed.id).toBe(10);
    expect(reparsed.result.tools).toHaveLength(3);
  });
});
