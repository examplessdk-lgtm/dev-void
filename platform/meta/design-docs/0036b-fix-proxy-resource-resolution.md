# Fix Proxy Resource Resolution

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

**Goal:** Fix remote bindings by resolving resources via the API service binding instead of a non-existent D1 table.

**Architecture:** The proxy currently queries a D1 database for the `resources` table, but that table only exists in PostgreSQL (Hyperdrive). Fix by adding an internal API endpoint (`/internal/resolve-resource`) and having the proxy call it via its existing `API` service binding — same pattern as `/internal/revalidate`.

**Tech Stack:** Hono, Drizzle ORM, CF service bindings, HMAC auth

---

### Task 1: Add `getResourceByBinding` query to API db.ts

**Files:**

- Modify: `platform/packages/api/src/db.ts` (after line 275)

**Step 1: Add the query function**

After the existing `getProjectResources` function (~line 275), add:

```typescript
export async function getResourceByBinding(
  db: Db,
  projectId: string,
  type: string,
  bindingName: string,
): Promise<{ cf_id: string } | undefined> {
  return db
    .select({ cf_id: resources.cf_id })
    .from(resources)
    .where(
      and(
        eq(resources.project_id, projectId),
        eq(resources.type, type),
        eq(resources.binding_name, bindingName),
      ),
    )
    .then((rows) => rows[0]);
}
```

Ensure `and` is imported from `drizzle-orm` (check existing imports at top of file).

---

### Task 2: Add `/internal/resolve-resource` endpoint to API

**Files:**

- Create: `platform/packages/api/src/routes/internal-resolve-resource.ts`
- Modify: `platform/packages/api/src/index.ts` (~line 48, add route mount)

**Step 1: Create the route file**

Follow the exact pattern of `platform/packages/api/src/routes/internal-revalidate.ts`:

```typescript
import { Hono } from 'hono';
import type { ApiEnv } from '../env';
import { getResourceByBinding } from '../db';
import { hmacVerifyState } from '../auth/hmac';

const app = new Hono<ApiEnv>();

/**
 * Internal resource resolution endpoint -- called by the proxy via service binding.
 * Authenticated via HMAC token in X-Void-Internal header (no JWT/userId).
 *
 * POST /internal/resolve-resource/:projectId
 * Body: { "type": "d1" | "kv" | "r2", "binding": "DB" }
 * Returns: { "cf_id": "..." } or 404
 */
app.post('/:projectId', async (c) => {
  const projectId = c.req.param('projectId');

  const token = c.req.header('x-void-internal');
  if (!token) {
    return c.json({ error: 'missing internal auth' }, 401);
  }
  if (!(await hmacVerifyState(projectId, token, c.env.JWT_SECRET))) {
    return c.json({ error: 'invalid internal auth' }, 403);
  }

  const { type, binding } = await c.req.json<{ type: string; binding: string }>();
  if (!type || !binding) {
    return c.json({ error: 'type and binding required' }, 400);
  }

  const resource = await getResourceByBinding(c.get('db'), projectId, type, binding);
  if (!resource) {
    return c.json({ error: `unknown binding "${binding}"` }, 404);
  }

  return c.json({ cf_id: resource.cf_id });
});

export default app;
```

**Step 2: Mount in API index.ts**

In `platform/packages/api/src/index.ts`, add import and mount next to the existing internal route:

```typescript
import internalResolveResource from "./routes/internal-resolve-resource";
// ...
.route("/internal/resolve-resource", internalResolveResource)
```

Place it right after the existing `.route("/internal/revalidate", internalRevalidate)` line.

---

### Task 3: Add HMAC signing to proxy and rewrite resolveResource

**Files:**

- Modify: `platform/packages/proxy/src/resolve.ts` (full rewrite)
- Modify: `platform/packages/proxy/src/types.ts` (remove `DB: D1Database`)

**Step 1: Rewrite resolve.ts**

Replace the D1 query with a service binding call to the API. The proxy has `JWT_SECRET` and can compute HMAC(projectId) to authenticate.

```typescript
/**
 * Resolves a project's binding to its Cloudflare resource ID via the API service binding.
 */
export async function resolveResource(
  api: Fetcher,
  jwtSecret: string,
  projectId: string,
  type: 'd1' | 'kv' | 'r2',
  bindingName: string,
): Promise<string> {
  const token = await hmacSign(projectId, jwtSecret);
  const res = await api.fetch(`https://api/internal/resolve-resource/${projectId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-void-internal': token,
    },
    body: JSON.stringify({ type, binding: bindingName }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Resource resolution failed (${res.status}): ${text}`);
  }

  const data = await res.json<{ cf_id: string }>();
  return data.cf_id;
}

// --- HMAC signing (mirrors platform/packages/api/src/auth/hmac.ts) ---

const encoder = new TextEncoder();
let cachedSignKey: CryptoKey | undefined;
let cachedKeySecret: string | undefined;

async function getSignKey(secret: string): Promise<CryptoKey> {
  if (cachedSignKey && cachedKeySecret === secret) return cachedSignKey;
  cachedSignKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  cachedKeySecret = secret;
  return cachedSignKey;
}

async function hmacSign(data: string, secret: string): Promise<string> {
  const key = await getSignKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  const binary = String.fromCharCode(...new Uint8Array(sig));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
```

**Step 2: Update types.ts**

Remove `DB: D1Database` from the `Env` type in `platform/packages/proxy/src/types.ts`.

---

### Task 4: Update all callers of resolveResource

**Files:**

- Modify: `platform/packages/proxy/src/d1.ts` (lines 19, 72)
- Modify: `platform/packages/proxy/src/kv.ts` (all resolveResource calls)
- Modify: `platform/packages/proxy/src/r2.ts` (all resolveResource calls)

All callers currently do:

```typescript
dbId = await resolveResource(c.env.DB, projectId, 'd1', body.binding);
```

Change to:

```typescript
dbId = await resolveResource(c.env.API, c.env.JWT_SECRET, projectId, 'd1', body.binding);
```

Same pattern for all kv.ts and r2.ts callers — replace `c.env.DB` with `c.env.API, c.env.JWT_SECRET`.

---

### Task 5: Remove D1 binding from proxy wrangler config

**Files:**

- Modify: `platform/packages/proxy/wrangler.jsonc` (remove d1_databases blocks)
- Modify: `platform/packages/proxy/src/index.ts` (remove `db: !!c.env.DB` from health check)

Remove the `d1_databases` array from both the production and staging env sections. Remove or update the health check reference to `c.env.DB`.

---

### Task 6: Update proxy tests

**Files:**

- Modify: `platform/packages/proxy/test/unit/d1.test.ts`
- Modify: any other test files that mock `c.env.DB`

Update the test mocks: replace D1 mocks with a mock `API` fetcher that returns `{ cf_id: "..." }` for resolve-resource calls.

---

### Task 7: Verify end-to-end

**Step 1:** Run `pnpm -r build` to confirm everything compiles.

**Step 2:** Run `pnpm test` to confirm all tests pass.

**Step 3:** Run `pnpm lint && pnpm fmt && pnpm check`.

**Step 4:** Deploy proxy and API to staging, then test with:

```
cd playground/kitchen-sink
VOID_REMOTE=1 pnpm dev
```

Confirm the DB query works without the "unknown binding" error.
