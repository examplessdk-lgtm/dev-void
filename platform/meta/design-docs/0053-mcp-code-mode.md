---
title: MCP Code Mode for Platform API
status: approved
---

# MCP Code Mode for Platform API

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

Add a `query` tool to the Void MCP server that lets AI agents write JavaScript to interact with the platform API, inspired by [Cloudflare's Code Mode MCP](https://blog.cloudflare.com/code-mode-mcp/).

## Motivation

The current MCP server (`void mcp`) only exposes documentation tools. Agents that need platform data (projects, deployments, logs) must shell out to CLI commands and parse text output. A code mode tool lets agents compose multiple API queries in a single invocation with structured results.

## Design Decisions

- **Full API access.** The SDK exposes all `PlatformClient` methods (reads and mutations) plus a `link()` helper. Deploy-related methods (`deploy`, `preflight`) are available but not documented in the tool description since they require FormData. The SDK auto-binds all prototype methods without exposing private fields (`token`, `baseUrl`).
- **Local execution.** Code runs in the `void mcp` process via `new AsyncFunction()`. No remote sandbox — the SDK methods are pre-authenticated HTTP calls to `api.platform.example.net`, which already has auth and rate limiting.
- **Implicit auth.** The MCP server uses CLI authentication (or `VOID_TOKEN`) for the selected platform. The token never enters the LLM context.
- **Coexists with docs tools.** The 3 existing tools (`list_pages`, `get_page`, `search_docs`) remain unchanged. `query` is a 4th tool.

## Tool Definition

```json
{
  "name": "query",
  "description": "Execute JavaScript to query the Void platform API. ...",
  "inputSchema": {
    "type": "object",
    "properties": {
      "code": {
        "type": "string",
        "description": "JavaScript async arrow function to execute"
      }
    },
    "required": ["code"]
  }
}
```

The tool description includes the full SDK type signatures so the LLM knows what methods are available and what they return.

## SDK Methods

The `void_` object exposes all `PlatformClient` prototype methods via auto-binding, plus a `link()` helper. Private fields (`token`, `baseUrl`) are not exposed. Key methods:

| Method                                                   | Returns                                                           |
| -------------------------------------------------------- | ----------------------------------------------------------------- |
| `void_.whoami()`                                         | `{ login, plan }`                                                 |
| `void_.listProjects()`                                   | `ProjectResponse[]`                                               |
| `void_.createProject(slug)`                              | `{ id, slug }`                                                    |
| `void_.deleteProject(projectId)`                         | `{ ok, id, slug, warnings? }`                                     |
| `void_.link(slug)`                                       | `{ projectId, slug, created }` — also writes `.void/project.json` |
| `void_.listDeployments(projectId)`                       | `{ deployments, activeDeploymentId }`                             |
| `void_.rollback(projectId, deploymentId)`                | `{ ok, deploymentId?, migrationDiff?, error? }`                   |
| `void_.getLogs(projectId, since, limit?, deploymentId?)` | `LogEntry[]`                                                      |
| `void_.listSecrets(projectId)`                           | `{ name }[]`                                                      |
| `void_.setSecret(projectId, name, value)`                | `{ ok, name }`                                                    |
| `void_.deleteSecret(projectId, name)`                    | `{ ok, name }`                                                    |
| `void_.listDomains(projectId)`                           | `DomainResponse[]`                                                |
| `void_.getDomainStatus(projectId, domainId)`             | `DomainStatusResponse`                                            |
| `void_.addDomain(projectId, hostname)`                   | `DomainResponse`                                                  |
| `void_.removeDomain(projectId, domainId)`                | `{ ok }`                                                          |
| `void_.getMigrationStatus(projectId)`                    | `{ applied: { name, applied_at }[] }`                             |
| `void_.setDatabaseUrl(projectId, url)`                   | `{ ok }`                                                          |
| `void_.getResources(projectId)`                          | `{ type, binding_name }[]`                                        |

## Execution Model

```typescript
const sdk = createQuerySdk(token);
const fn = new AsyncFunction('void', `return await (${code})()`);
const result = await Promise.race([
  fn(sdk),
  new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10_000)),
]);
```

- 10-second timeout via `Promise.race`
- Errors caught and returned as MCP error responses (`isError: true`)
- Result serialized via `JSON.stringify`

## Examples

**List projects:**

```js
async () => await void_.listProjects();
```

**Recent errors for a specific project:**

```js
async () => {
  const projects = await void_.listProjects();
  const p = projects.find((p) => p.slug === 'my-app');
  const logs = await void_.getLogs(p.id, '1h');
  return logs.filter((l) => l.exceptions.length > 0);
};
```

**Rollback to previous deployment:**

```js
async () => {
  const projects = await void_.listProjects();
  const p = projects.find((p) => p.slug === 'my-app');
  const { deployments } = await void_.listDeployments(p.id);
  const prev = deployments.find((d) => d.retained && d.status === 'active');
  return await void_.rollback(p.id, prev.id);
};
```

**Add a custom domain:**

```js
async () => {
  const projects = await void_.listProjects();
  const p = projects.find((p) => p.slug === 'my-app');
  return await void_.addDomain(p.id, 'example.com');
};
```

## File Changes

All in the framework package:

1. **`packages/void/src/cli/mcp.ts`** — Add `query` tool definition, SDK factory, code execution handler. Import `PlatformClient` and auth utilities.
2. **`packages/void/test/unit/mcp.test.ts`** — Tests for the query tool with mocked API calls.

No new files. No new dependencies.
