import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'pathslash';
import { getToken } from './auth.ts';
import { PlatformClient } from './client.ts';
import { writeProjectConfig } from './project.ts';

// --- Types ---

type DocPage = {
  slug: string;
  title: string;
  content: string;
};

type SearchResult = {
  slug: string;
  title: string;
  snippet: string;
  score: number;
};

type JsonRpcRequest = {
  jsonrpc: string;
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
};

// --- Doc loading ---

function findPackageRoot(from: string): string {
  let dir = from;
  while (true) {
    if (existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(`mcp: Could not find package.json from '${from}'.`);
}

function resolveDocsDir(): string {
  const pkgRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));

  // Bundled docs (dist + npm installs)
  const bundledDocsDir = join(pkgRoot, 'skills', 'void', 'docs');
  if (existsSync(bundledDocsDir)) {
    return bundledDocsDir;
  }

  // Monorepo fallback for local development before package build.
  const workspaceDocsDir = join(pkgRoot, '..', '..', 'docs');
  if (existsSync(workspaceDocsDir)) {
    return workspaceDocsDir;
  }

  throw new Error(
    `mcp: Void docs directory not found. Expected bundled docs at '${bundledDocsDir}'.`,
  );
}

function findMdFiles(dir: string, prefix = ''): Array<string> {
  const results: Array<string> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
      continue;
    }
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      results.push(...findMdFiles(join(dir, entry.name), rel));
    } else if (entry.name.endsWith('.md')) {
      results.push(rel);
    }
  }
  return results;
}

function loadDocs(): Array<DocPage> {
  const docsDir = resolveDocsDir();

  const files = findMdFiles(docsDir).sort();

  return files.map((file) => {
    let content = readFileSync(join(docsDir, file), 'utf-8');

    // Strip YAML frontmatter
    content = content.replace(/^---\n[\s\S]*?\n---\n/, '');

    // Extract title from first heading
    const titleMatch = content.match(/^#\s+(.+)/m);
    const title = titleMatch ? titleMatch[1].trim() : file.replace(/\.md$/, '');

    const slug = file.replace(/\.md$/, '');

    return { slug, title, content };
  });
}

// --- Search ---

export function searchDocs(pages: Array<DocPage>, query: string): Array<SearchResult> {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (terms.length === 0) {
    return [];
  }

  const scored: Array<SearchResult> = [];

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
        if (firstMatchIndex === -1) {
          firstMatchIndex = idx;
        }
        idx += term.length;
      }
    }

    if (score === 0) {
      continue;
    }

    // Extract snippet around first match
    let snippet: string;
    if (firstMatchIndex !== -1) {
      const start = Math.max(0, firstMatchIndex - 80);
      const end = Math.min(page.content.length, firstMatchIndex + 120);
      snippet =
        (start > 0 ? '...' : '') +
        page.content.slice(start, end).trim() +
        (end < page.content.length ? '...' : '');
    } else {
      snippet = page.content.slice(0, 200).trim() + '...';
    }

    scored.push({ slug: page.slug, title: page.title, snippet, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5);
}

// --- Query SDK ---

function createQuerySdk(token: string) {
  const client = new PlatformClient(token, { root: process.cwd() });

  // Auto-bind all PlatformClient methods without exposing private fields
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk: Record<string, (...args: Array<any>) => unknown> = {};
  const proto = Object.getPrototypeOf(client) as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key === 'constructor') {
      continue;
    }
    const val = proto[key];
    if (typeof val === 'function') {
      sdk[key] = val.bind(client);
    }
  }

  // link: find-or-create project + write .void/project.json
  sdk.link = async (slug: string) => {
    const projects = await client.listProjects();
    const existing = projects.find((p) => p.slug === slug);
    if (existing) {
      writeProjectConfig(process.cwd(), { projectId: existing.id, slug: existing.slug });
      return { projectId: existing.id, slug: existing.slug, created: false };
    }
    const created = await client.createProject(slug);
    writeProjectConfig(process.cwd(), { projectId: created.id, slug: created.slug });
    return { projectId: created.id, slug: created.slug, created: true };
  };

  return sdk;
}

// --- Tool definitions ---

const TOOLS = [
  {
    name: 'list_pages',
    description: 'List all Void documentation pages with their slugs and titles',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_page',
    description: 'Get the full content of a Void documentation page by slug',
    inputSchema: {
      type: 'object' as const,
      properties: {
        slug: {
          type: 'string',
          description: "Page slug, e.g. 'routing' or 'quickstart'",
        },
      },
      required: ['slug'],
    },
  },
  {
    name: 'search_docs',
    description:
      'Search Void documentation by keyword query. Returns top 5 matching pages with snippets.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: "Search query, e.g. 'file routing' or 'database migrations'",
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'query',
    description: `Execute JavaScript to interact with the Void platform API.

Available methods on the "void_" object:

  Account:
    void_.whoami() → { login, plan }

  Projects:
    void_.listProjects() → { id, slug, type, created_at, custom_domain }[]
    void_.createProject(slug) → { id, slug }
    void_.deleteProject(projectId) → { ok, id, slug, warnings? }
    void_.link(slug) → { projectId, slug, created } — find-or-create project + write .void/project.json

  Deployments:
    void_.listDeployments(projectId) → { deployments, activeDeploymentId }
    void_.rollback(projectId, deploymentId, options?) → { ok, deploymentId?, migrationDiff?, error? }
      options.allowDestructive: string[] of migration names the current
      active has that target lacks. Required for destructive rollbacks;
      server returns 400 if omitted or if its view of the set has drifted.

  Logs:
    void_.getLogs(projectId, since, limit?, deploymentId?) → { timestamp, outcome, logs, exceptions, url, method, status }[]
      since: duration string (e.g. "1h"), limit: number (default 200)

  Requests:
    void_.getRequests(projectId, since, limit?, status?) → { timestamp, type, method, status, bytes, durationMs }[]
      since: duration string (e.g. "1h"), limit: number (default 200), status: class like "5xx" or exact code like "500"
      Edge request metering — includes edge-generated 5xx and static/SPA requests that never invoke a worker.

  Secrets:
    void_.listSecrets(projectId) → { name }[]
    void_.setSecret(projectId, name, value) → { ok, name }
    void_.deleteSecret(projectId, name) → { ok, name }

  Domains:
    void_.listDomains(projectId) → { id, hostname, status, cname_target? }[]
    void_.getDomainStatus(projectId, domainId) → { hostname, status, ssl_status, verification_errors? }
    void_.addDomain(projectId, hostname) → { id, hostname, status, cname_target? }
    void_.removeDomain(projectId, domainId) → { ok }

  Database:
    void_.getMigrationStatus(projectId) → { applied: { name, applied_at }[] }
    void_.setDatabaseUrl(projectId, connectionString) → { ok }
    void_.getResources(projectId) → { type, binding_name }[]

Write an async arrow function in JavaScript. The SDK is available as "void_".
Example: async () => { const ps = await void_.listProjects(); return ps.map(p => p.slug); }`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        code: {
          type: 'string',
          description: 'JavaScript async arrow function to execute',
        },
      },
      required: ['code'],
    },
  },
];

// --- JSON-RPC dispatch ---

export type McpContext = {
  pages: Array<DocPage>;
  token: string | null;
};

export function handleRequest(
  ctx: McpContext,
  req: JsonRpcRequest,
): object | null | Promise<object | null> {
  const { method, id, params } = req;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'void', version: '1.0.0' },
      },
    };
  }

  if (method === 'notifications/initialized') {
    // Notification — no response
    return null;
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }

  if (method === 'tools/call') {
    const toolName = (params as Record<string, unknown>)?.name as string;
    const toolArgs = ((params as Record<string, unknown>)?.arguments ?? {}) as Record<
      string,
      unknown
    >;

    if (toolName === 'list_pages') {
      const list = ctx.pages.map((p) => ({ slug: p.slug, title: p.title }));
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] },
      };
    }

    if (toolName === 'get_page') {
      const slug = toolArgs.slug as string;
      const page = ctx.pages.find((p) => p.slug === slug);
      if (!page) {
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: `Page not found: ${slug}` }], isError: true },
        };
      }
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: page.content }] },
      };
    }

    if (toolName === 'search_docs') {
      const query = toolArgs.query as string;
      const results = searchDocs(ctx.pages, query);
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] },
      };
    }

    if (toolName === 'query') {
      const code = toolArgs.code as string;

      if (!ctx.token) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: 'Not logged in. Run `void auth login` first.' }],
            isError: true,
          },
        };
      }

      const sdk = createQuerySdk(ctx.token);
      const AsyncFunction = async function () {}.constructor as new (
        ...args: Array<string>
      ) => (...args: Array<unknown>) => Promise<unknown>;

      return (async () => {
        try {
          const fn = new AsyncFunction('void_', `return await (${code})()`);
          const result = await Promise.race([
            fn(sdk),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('mcp: Query timed out after 10 seconds.')), 10_000),
            ),
          ]);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            },
          };
        } catch (err) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: `Error: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              isError: true,
            },
          };
        }
      })();
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Unknown tool: ${toolName}` },
    };
  }

  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Unknown method: ${method}` },
  };
}

// --- Entry point ---

export function runMcp(): void {
  const pages = loadDocs();
  const token = getToken(process.cwd());
  const ctx: McpContext = { pages, token };

  const rl = createInterface({ input: process.stdin });

  rl.on('line', async (line) => {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line);
    } catch {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        }) + '\n',
      );
      return;
    }

    const response = await handleRequest(ctx, req);
    if (response !== null) {
      process.stdout.write(JSON.stringify(response) + '\n');
    }
  });
}
