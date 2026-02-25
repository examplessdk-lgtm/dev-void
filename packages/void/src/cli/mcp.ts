import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// --- Types ---

interface DocPage {
  slug: string;
  title: string;
  content: string;
}

interface SearchResult {
  slug: string;
  title: string;
  snippet: string;
  score: number;
}

interface JsonRpcRequest {
  jsonrpc: string;
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

// --- Doc loading ---

function resolveDocsDir(): string {
  const moduleDir = join(fileURLToPath(import.meta.url), "..");
  const bundledDocsDir = join(moduleDir, "..", "..", "skills", "void", "docs");
  if (existsSync(bundledDocsDir)) {
    return bundledDocsDir;
  }

  // Monorepo fallback for local development before package build.
  const workspaceDocsDir = join(moduleDir, "..", "..", "..", "website", "docs");
  if (existsSync(workspaceDocsDir)) {
    return workspaceDocsDir;
  }

  throw new Error(`Void docs directory not found. Expected bundled docs at: ${bundledDocsDir}`);
}

function loadDocs(): DocPage[] {
  const docsDir = resolveDocsDir();

  const files = readdirSync(docsDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  return files.map((file) => {
    let content = readFileSync(join(docsDir, file), "utf-8");

    // Strip YAML frontmatter
    content = content.replace(/^---\n[\s\S]*?\n---\n/, "");

    // Extract title from first heading
    const titleMatch = content.match(/^#\s+(.+)/m);
    const title = titleMatch ? titleMatch[1].trim() : file.replace(/\.md$/, "");

    const slug = file.replace(/\.md$/, "");

    return { slug, title, content };
  });
}

// --- Search ---

export function searchDocs(pages: DocPage[], query: string): SearchResult[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (terms.length === 0) return [];

  const scored: SearchResult[] = [];

  for (const page of pages) {
    const titleLower = page.title.toLowerCase();
    const contentLower = page.content.toLowerCase();
    let score = 0;
    let firstMatchIndex = -1;

    for (const term of terms) {
      // Title matches weighted 3x
      let idx = 0;
      while ((idx = titleLower.indexOf(term, idx)) !== -1) {
        score += 3;
        idx += term.length;
      }

      // Content matches
      idx = 0;
      while ((idx = contentLower.indexOf(term, idx)) !== -1) {
        score += 1;
        if (firstMatchIndex === -1) firstMatchIndex = idx;
        idx += term.length;
      }
    }

    if (score === 0) continue;

    // Extract snippet around first match
    let snippet: string;
    if (firstMatchIndex !== -1) {
      const start = Math.max(0, firstMatchIndex - 80);
      const end = Math.min(page.content.length, firstMatchIndex + 120);
      snippet =
        (start > 0 ? "..." : "") +
        page.content.slice(start, end).trim() +
        (end < page.content.length ? "..." : "");
    } else {
      snippet = page.content.slice(0, 200).trim() + "...";
    }

    scored.push({ slug: page.slug, title: page.title, snippet, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5);
}

// --- Tool definitions ---

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
        slug: {
          type: "string",
          description: "Page slug, e.g. 'routing' or 'quickstart'",
        },
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

// --- JSON-RPC dispatch ---

function handleRequest(pages: DocPage[], req: JsonRpcRequest): object | null {
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

  if (method === "notifications/initialized") {
    // Notification — no response
    return null;
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }

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
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: page.content }] },
      };
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

    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unknown tool: ${toolName}` },
    };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Unknown method: ${method}` },
  };
}

// --- Entry point ---

export function runMcp(): void {
  const pages = loadDocs();

  const rl = createInterface({ input: process.stdin });

  rl.on("line", (line) => {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line);
    } catch {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }) + "\n",
      );
      return;
    }

    const response = handleRequest(pages, req);
    if (response !== null) {
      process.stdout.write(JSON.stringify(response) + "\n");
    }
  });
}
