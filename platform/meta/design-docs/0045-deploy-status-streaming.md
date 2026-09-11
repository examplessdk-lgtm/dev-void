---
title: Deploy Status Streaming
status: approved
created: 2026-03-02
---

# Deploy Status Streaming

## Context

The deploy endpoint (`POST /projects/:id/deploy`) processes multiple phases — asset upload, binding provisioning, migrations, worker upload, prerendering, routing — but returns a single JSON response at the end. The CLI shows a blind spinner during the entire deploy. This design adds streaming progress events so the CLI can display granular status updates.

## Protocol

The deploy endpoint returns `Content-Type: application/x-ndjson` (newline-delimited JSON). Each line is a self-contained JSON object with an `event` discriminator field. Events are emitted in pipeline order.

Pre-checks (ownership, rate limit, manifest validation) happen **before** the stream starts and return normal JSON error responses with proper HTTP status codes (404, 403, 429, 400). Once the stream opens, the response is always HTTP 200 — errors are communicated via the `error` event.

## Event Catalog

```
# Always first
{"event":"start","deploymentId":"dep_abc123"}

# Asset upload (if assets exist)
{"event":"asset_upload","total":42,"new":3,"cached":39}
{"event":"asset_upload_done"}

# Binding provisioning (if bindings requested)
{"event":"provisioning","bindings":["d1:DB","kv:CACHE","r2:FILES","ai"]}
{"event":"provisioning_done"}

# Migrations (one per migration file)
{"event":"migration","name":"001_init.sql","index":1,"total":3}
{"event":"migration","name":"002_add_users.sql","index":2,"total":3}
{"event":"migration","name":"003_add_posts.sql","index":3,"total":3}

# Worker upload
{"event":"worker_upload","modules":2}
{"event":"worker_upload_done"}

# Queue setup (if any)
{"event":"queue_setup","queues":["email","notifications"]}

# ISR prerender (if any)
{"event":"prerender","pages":5}
{"event":"prerender_done"}

# Terminal event (exactly one of done/error)
{"event":"done","deployment":"dep_abc","url":"https://app.void.app","urls":["https://app.void.app"],"assets":42,"workers":2,"migrations":3}
{"event":"error","message":"migration failed: syntax error","step":"migration"}
```

### Static-only path

Shorter sequence: `start → asset_upload → asset_upload_done → worker_upload → worker_upload_done → done`.

### Granularity decisions

- **Assets**: summary only (total/new/cached counts). Per-bucket progress not needed since uploads are fast.
- **Migrations**: per-migration events. They can be slow and fail individually — granularity is useful for debugging.
- **Prerender**: summary only (page count). Individual page results not critical for CLI display.

## Type Definition

Discriminated union, defined in both `packages/api/src/types.ts` and `framework/packages/void/src/cli/types.ts`:

```ts
type DeployEvent =
  | { event: 'start'; deploymentId: string }
  | { event: 'asset_upload'; total: number; new: number; cached: number }
  | { event: 'asset_upload_done' }
  | { event: 'provisioning'; bindings: string[] }
  | { event: 'provisioning_done' }
  | { event: 'migration'; name: string; index: number; total: number }
  | { event: 'worker_upload'; modules: number }
  | { event: 'worker_upload_done' }
  | { event: 'queue_setup'; queues: string[] }
  | { event: 'prerender'; pages: number }
  | { event: 'prerender_done' }
  | {
      event: 'done';
      deployment: string;
      url: string;
      urls: string[];
      assets: number;
      workers: number;
      migrations?: number;
    }
  | { event: 'error'; message: string; step: string };
```

The `step` field on `error` matches event name prefixes: `"asset_upload"`, `"provisioning"`, `"migration"`, `"worker_upload"`, `"prerender"`, `"routing"`.

## API Implementation

The deploy handler wraps its pipeline body in a `ReadableStream`:

```ts
app.post("/:id/deploy", async (c) => {
  // Pre-checks: ownership, concurrent deploy, rate limit, manifest validation
  // These return normal JSON errors before the stream starts.

  const deployment = await createDeployment(...);

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: object) => {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n"));
      };

      try {
        emit({ event: "start", deploymentId: deployment.id });
        // ... pipeline phases with emit() calls between each ...
        emit({ event: "done", ... });
      } catch (err) {
        emit({ event: "error", message: err.message, step: currentStep });
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson" }
  });
});
```

## CLI Consumption

An async generator reads NDJSON lines from the fetch response body:

```ts
async function* readNDJSON(response: Response): AsyncGenerator<DeployEvent> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIdx;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      if (line.trim()) yield JSON.parse(line);
    }
  }
}
```

The deploy flow updates the `@clack/prompts` spinner message per event:

```ts
for await (const event of readNDJSON(response)) {
  switch (event.event) {
    case 'start':
      s.message('Deploying...');
      break;
    case 'asset_upload':
      s.message(`Uploading assets (${event.new} new, ${event.cached} cached)`);
      break;
    case 'provisioning':
      s.message(`Provisioning ${event.bindings.join(', ')}`);
      break;
    case 'migration':
      s.message(`Running migration ${event.index}/${event.total}: ${event.name}`);
      break;
    case 'worker_upload':
      s.message('Uploading worker...');
      break;
    case 'prerender':
      s.message(`Prerendering ${event.pages} pages...`);
      break;
    case 'done':
      s.stop('Deployed!');
      break;
    case 'error':
      s.stop('Deploy failed');
      break;
  }
}
```

Unknown events are silently ignored for forward compatibility.

### Error handling

- **Pre-stream errors** (HTTP 4xx): `client.deployStream()` checks status before returning the response. Throws on non-200 with the JSON error body.
- **Stream errors** (`error` event): the `for await` loop handles the `error` event and displays the message with step context.
- **Connection drop**: the `for await` loop ends naturally. CLI detects missing terminal event (`done`/`error`) and reports a connection failure.
