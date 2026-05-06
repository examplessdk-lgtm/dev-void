import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'pathe';
import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { handleRequest, type McpContext } from '../../src/cli/mcp.ts';

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

// Replicate loadDocs logic for tests.
function loadDocs() {
  const bundledDocsDir = join(import.meta.dirname, '../../skills/void/docs');
  const docsDir = existsSync(bundledDocsDir)
    ? bundledDocsDir
    : join(import.meta.dirname, '../../../../docs');
  const files = findMdFiles(docsDir).sort();
  return files.map((file) => {
    let content = readFileSync(join(docsDir, file), 'utf-8');
    content = content.replace(/^---\n[\s\S]*?\n---\n/, '');
    const titleMatch = content.match(/^#\s+(.+)/m);
    const title = titleMatch ? titleMatch[1].trim() : file.replace(/\.md$/, '');
    const slug = file.replace(/\.md$/, '');
    return { slug, title, content };
  });
}

describe('mcp server handler', () => {
  let ctx: McpContext;

  beforeAll(() => {
    ctx = { pages: loadDocs(), token: null };
  });

  it('responds to initialize', () => {
    const res = handleRequest(ctx, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    }) as Record<string, unknown>;

    expect(res.id).toBe(1);
    const result = res.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.capabilities).toEqual({ tools: {} });
    expect(result.serverInfo).toEqual({ name: 'void', version: '1.0.0' });
  });

  it('handles notifications/initialized (returns null)', () => {
    const res = handleRequest(ctx, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(res).toBeNull();
  });

  it('responds to ping', () => {
    const res = handleRequest(ctx, {
      jsonrpc: '2.0',
      id: 2,
      method: 'ping',
    }) as Record<string, unknown>;
    expect(res.id).toBe(2);
    expect(res.result).toEqual({});
  });

  it('responds to tools/list with 3 tools', () => {
    const res = handleRequest(ctx, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
    }) as Record<string, unknown>;
    const result = res.result as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(4);
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('list_pages');
    expect(names).toContain('get_page');
    expect(names).toContain('search_docs');
  });

  it('tools/call list_pages returns pages with slug and title', () => {
    const res = handleRequest(ctx, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'list_pages', arguments: {} },
    }) as Record<string, unknown>;
    const result = res.result as { content: Array<{ type: string; text: string }> };
    const list = JSON.parse(result.content[0].text);
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]).toHaveProperty('slug');
    expect(list[0]).toHaveProperty('title');
  });

  it('tools/call get_page returns page content', () => {
    const slug = ctx.pages[0].slug;
    const res = handleRequest(ctx, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'get_page', arguments: { slug } },
    }) as Record<string, unknown>;
    const result = res.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  it('tools/call get_page returns error for unknown slug', () => {
    const res = handleRequest(ctx, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'get_page', arguments: { slug: 'nonexistent-page' } },
    }) as Record<string, unknown>;
    const result = res.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('nonexistent-page');
  });

  it('tools/call search_docs returns results', () => {
    const res = handleRequest(ctx, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'search_docs', arguments: { query: 'routing' } },
    }) as Record<string, unknown>;
    const result = res.result as { content: Array<{ text: string }> };
    const results = JSON.parse(result.content[0].text);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty('slug');
    expect(results[0]).toHaveProperty('title');
    expect(results[0]).toHaveProperty('snippet');
    expect(results[0]).toHaveProperty('score');
  });

  it('returns error for unknown method', () => {
    const res = handleRequest(ctx, {
      jsonrpc: '2.0',
      id: 8,
      method: 'unknown/method',
    }) as Record<string, unknown>;
    expect(res.error).toBeDefined();
    const error = res.error as { code: number; message: string };
    expect(error.code).toBe(-32601);
  });

  it('returns error for unknown tool', () => {
    const res = handleRequest(ctx, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'nonexistent_tool', arguments: {} },
    }) as Record<string, unknown>;
    expect(res.error).toBeDefined();
    const error = res.error as { code: number; message: string };
    expect(error.code).toBe(-32601);
  });

  it('JSON round-trip preserves valid JSON-RPC structure', () => {
    const request = JSON.stringify({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/list',
    });
    const parsed = JSON.parse(request);
    const response = handleRequest(ctx, parsed);
    const serialized = JSON.stringify(response);
    const reparsed = JSON.parse(serialized);
    expect(reparsed.jsonrpc).toBe('2.0');
    expect(reparsed.id).toBe(10);
    expect(reparsed.result.tools).toHaveLength(4);
  });
});

const mockFetch = vi.fn();

describe('query tool', () => {
  let ctx: McpContext;

  beforeAll(() => {
    ctx = { pages: loadDocs(), token: 'test-token' };
  });

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is listed in tools/list', () => {
    const res = handleRequest(ctx, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    }) as Record<string, unknown>;
    const result = res.result as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('query');
  });

  it('executes simple code that calls void_.listProjects()', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          id: 'p1',
          slug: 'my-app',
          type: 'void',
          created_at: '2026-01-01',
          user_id: 'u1',
          custom_domain: null,
        },
      ],
    });

    const res = await handleRequest(ctx, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'query',
        arguments: { code: 'async () => await void_.listProjects()' },
      },
    });

    const result = (res as Record<string, unknown>).result as { content: Array<{ text: string }> };
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveLength(1);
    expect(data[0].slug).toBe('my-app');
  });

  it('executes code that composes multiple calls', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          id: 'p1',
          slug: 'my-app',
          type: 'void',
          created_at: '2026-01-01',
          user_id: 'u1',
          custom_domain: null,
        },
      ],
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        deployments: [
          {
            id: 'd1',
            status: 'active',
            source: 'cli',
            commit: 'abc',
            manifest: null,
            error_message: null,
            retained: true,
            applied_migrations: null,
            created_at: '2026-01-01',
            deployed_at: '2026-01-01',
          },
        ],
        activeDeploymentId: 'd1',
      }),
    });

    const res = await handleRequest(ctx, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'query',
        arguments: {
          code: `async () => {
            const projects = await void_.listProjects();
            const p = projects.find(p => p.slug === "my-app");
            return await void_.listDeployments(p.id);
          }`,
        },
      },
    });

    const result = (res as Record<string, unknown>).result as { content: Array<{ text: string }> };
    const data = JSON.parse(result.content[0].text);
    expect(data.deployments).toHaveLength(1);
    expect(data.deployments[0].status).toBe('active');
  });

  it('returns error when code throws', async () => {
    const res = await handleRequest(ctx, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'query',
        arguments: { code: "async () => { throw new Error('boom') }" },
      },
    });

    const result = (res as Record<string, unknown>).result as {
      content: Array<{ text: string }>;
      isError: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('boom');
  });

  it('returns error when no token is available', async () => {
    const noAuthCtx: McpContext = { pages: loadDocs(), token: null };
    const res = await handleRequest(noAuthCtx, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'query',
        arguments: { code: 'async () => await void_.listProjects()' },
      },
    });

    const result = (res as Record<string, unknown>).result as {
      content: Array<{ text: string }>;
      isError: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Not logged in');
  });

  it('executes rollback via void_.rollback()', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, deploymentId: 'd2' }),
    });

    const res = await handleRequest(ctx, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'query',
        arguments: { code: 'async () => await void_.rollback("p1", "d1")' },
      },
    });

    const result = (res as Record<string, unknown>).result as { content: Array<{ text: string }> };
    const data = JSON.parse(result.content[0].text);
    expect(data.ok).toBe(true);
    expect(data.deploymentId).toBe('d2');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/projects/p1/rollback'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('rollback without options omits allowDestructive from the request body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, deploymentId: 'd2' }),
    });

    await handleRequest(ctx, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'query',
        arguments: { code: 'async () => await void_.rollback("p1", "d1")' },
      },
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.deploymentId).toBe('d1');
    expect(body).not.toHaveProperty('allowDestructive');
  });

  it('rollback with allowDestructive forwards the snapshot array in the request body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, deploymentId: 'd2', migrationDiff: ['m2.sql'] }),
    });

    await handleRequest(ctx, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'query',
        arguments: {
          code: 'async () => await void_.rollback("p1", "d1", { allowDestructive: ["m2.sql"] })',
        },
      },
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.deploymentId).toBe('d1');
    expect(body.allowDestructive).toEqual(['m2.sql']);
  });

  it('executes addDomain via void_.addDomain()', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'dom1',
        project_id: 'p1',
        hostname: 'example.com',
        cf_hostname_id: 'cf1',
        status: 'pending',
        created_at: '2026-01-01',
        cname_target: 'p1.void.app',
      }),
    });

    const res = await handleRequest(ctx, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'query',
        arguments: { code: 'async () => await void_.addDomain("p1", "example.com")' },
      },
    });

    const result = (res as Record<string, unknown>).result as { content: Array<{ text: string }> };
    const data = JSON.parse(result.content[0].text);
    expect(data.hostname).toBe('example.com');
    expect(data.cname_target).toBe('p1.void.app');
  });

  it('executes setSecret via void_.setSecret()', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, name: 'API_KEY' }),
    });

    const res = await handleRequest(ctx, {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'query',
        arguments: { code: 'async () => await void_.setSecret("p1", "API_KEY", "secret123")' },
      },
    });

    const result = (res as Record<string, unknown>).result as { content: Array<{ text: string }> };
    const data = JSON.parse(result.content[0].text);
    expect(data.ok).toBe(true);
    expect(data.name).toBe('API_KEY');
  });

  it('executes getMigrationStatus via void_.getMigrationStatus()', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        applied: [{ name: '001_init', applied_at: '2026-01-01' }],
      }),
    });

    const res = await handleRequest(ctx, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: {
        name: 'query',
        arguments: { code: 'async () => await void_.getMigrationStatus("p1")' },
      },
    });

    const result = (res as Record<string, unknown>).result as { content: Array<{ text: string }> };
    const data = JSON.parse(result.content[0].text);
    expect(data.applied).toHaveLength(1);
    expect(data.applied[0].name).toBe('001_init');
  });

  it('does not expose private fields (token, baseUrl)', async () => {
    const res = await handleRequest(ctx, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'query',
        arguments: { code: 'async () => ({ token: void_.token, baseUrl: void_.baseUrl })' },
      },
    });

    const result = (res as Record<string, unknown>).result as { content: Array<{ text: string }> };
    const data = JSON.parse(result.content[0].text);
    expect(data.token).toBeUndefined();
    expect(data.baseUrl).toBeUndefined();
  });
});
