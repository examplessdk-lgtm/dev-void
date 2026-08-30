import { describe, expect, it } from 'vite-plus/test';
import { inferBindingsFromSource, mergeBindings } from '../../src/inference/walk.ts';

describe('inferBindingsFromSource', () => {
  it('detects c.env.DB', () => {
    const code = `
      export default defineHandler((c) => {
        return c.env.DB.prepare('SELECT 1').first()
      })
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsD1).toBe(true);
    expect(result.needsKV).toBe(false);
    expect(result.needsR2).toBe(false);
  });

  it('detects c.env.KV', () => {
    const code = `
      export default defineHandler(async (c) => {
        return c.env.KV.get('key')
      })
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsKV).toBe(true);
  });

  it('detects env.DB in SSR-style handlers', () => {
    const code = `
      export async function render(request, env) {
        return Response.json(await env.DB.prepare('SELECT 1').first())
      }
    `;
    const result = inferBindingsFromSource(code, 'main.ssr.ts');
    expect(result.needsD1).toBe(true);
    expect(result.needsKV).toBe(false);
    expect(result.needsR2).toBe(false);
  });

  it('detects c.env.STORAGE', () => {
    const code = `
      export default defineHandler(async (c) => {
        await c.env.STORAGE.put('key', 'value')
      })
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsR2).toBe(true);
  });

  it('detects multiple bindings in one file', () => {
    const code = `
      export default defineHandler(async (c) => {
        const user = c.env.DB.prepare('SELECT 1').first()
        await c.env.KV.set('key', 'val')
        return user
      })
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsD1).toBe(true);
    expect(result.needsKV).toBe(true);
    expect(result.needsR2).toBe(false);
  });

  it('ignores unrelated member expressions', () => {
    const code = `
      const x = foo.bar.DB
      const y = something.env.other
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsD1).toBe(false);
  });

  it('handles env access patterns', () => {
    // This pattern: obj.env.DB — any *.env.DB triggers it
    const code = `
      const handler = (c) => {
        const result = c.env.DB.prepare('SELECT 1').all()
        return result
      }
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsD1).toBe(true);
  });

  it('returns empty for files with no bindings', () => {
    const code = `
      export default defineHandler(() => {
        return { status: 'ok' }
      })
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsD1).toBe(false);
    expect(result.needsKV).toBe(false);
    expect(result.needsR2).toBe(false);
    expect(result.needsAuth).toBe(false);
  });

  it("detects import { db } from 'void/db'", () => {
    const code = `
      import { db } from "void/db";
      export const GET = defineHandler(async () => {
        return db.list("users");
      })
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsD1).toBe(true);
    expect(result.needsKV).toBe(false);
    expect(result.needsR2).toBe(false);
  });

  it("detects import { kv } from 'void/kv'", () => {
    const code = `
      import { kv } from "void/kv";
      export const GET = defineHandler(async () => {
        return kv.get("key");
      })
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsKV).toBe(true);
    expect(result.needsD1).toBe(false);
    expect(result.needsR2).toBe(false);
  });

  it("detects import { storage } from 'void/storage'", () => {
    const code = `
      import { storage } from "void/storage";
      export const POST = defineHandler(async () => {
        await storage.put("file.txt", "content");
      })
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsR2).toBe(true);
    expect(result.needsD1).toBe(false);
    expect(result.needsKV).toBe(false);
  });

  it("detects import { createDb } from 'void/db'", () => {
    const code = `
      import { createDb } from "void/db";
      export const GET = defineHandler(async (c) => {
        const myDb = createDb(c.env.OTHER_DB);
        return myDb.list("users");
      })
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsD1).toBe(true);
  });

  it('handles invalid code gracefully', () => {
    const result = inferBindingsFromSource('not { valid {{{ code', 'bad.ts');
    expect(result.needsD1).toBe(false);
    expect(result.needsKV).toBe(false);
    expect(result.needsR2).toBe(false);
    expect(result.needsAuth).toBe(false);
  });

  it("detects import { auth } from 'void/client'", () => {
    const code = `
      import { auth } from "void/client";
      await auth.signOut();
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsAuth).toBe(true);
  });

  it("detects auth imports from 'void/client' alongside other client helpers", () => {
    const code = `
      import { auth, fetch } from "void/client";
      await auth.signIn.email({ email, password });
      await fetch("/api/hello");
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsAuth).toBe(true);
  });

  it("detects auth imports from framework-specific 'void/client' subpaths", () => {
    const code = `
      import { auth } from "void/client/react";
      await auth.useSession();
    `;
    const result = inferBindingsFromSource(code, 'test.tsx');
    expect(result.needsAuth).toBe(true);
  });

  it("does not detect auth from 'void/client' when only fetch is imported", () => {
    const code = `
      import { fetch } from "void/client";
      const data = await fetch("/api/hello");
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsAuth).toBe(false);
  });

  it("does not detect auth from framework-specific 'void/client' subpaths when only fetch is imported", () => {
    const code = `
      import { fetch } from "void/client/react";
      const data = await fetch("/api/hello");
    `;
    const result = inferBindingsFromSource(code, 'test.tsx');
    expect(result.needsAuth).toBe(false);
  });

  it("detects import from 'void/auth'", () => {
    const code = `
      import { requireAuth } from "void/auth";
      export const GET = defineHandler((c) => {
        const user = requireAuth(c);
        return { user };
      })
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsAuth).toBe(true);
  });

  it('does not detect auth from unrelated imports', () => {
    const code = `
      import { db } from "void/db";
      import { fetch } from "void/client";
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsAuth).toBe(false);
    expect(result.needsD1).toBe(true);
  });

  it('detects needsQueues from void/queues import', () => {
    const code = `
      import { queues } from "void/queues";
      await queues.emails.send({});
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsQueues).toBe(true);
  });

  it('detects needsQueues from env.QUEUE_* access', () => {
    const code = `
      export const POST = defineHandler(async (c) => {
        await c.env.QUEUE_EMAILS.send({ to: "test@example.com" });
        return c.json({ ok: true });
      })
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsQueues).toBe(true);
  });

  it('does not detect needsQueues from unrelated identifiers', () => {
    const code = `
      export const GET = defineHandler(() => {
        return { status: 'ok' }
      })
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsQueues).toBe(false);
  });

  it("detects import { ai } from 'void/ai'", () => {
    const code = `
      import { ai } from "void/ai";
      export const POST = defineHandler(async () => {
        const result = await ai.run("@cf/meta/llama-3.1-8b-instruct", {
          messages: [{ role: "user", content: "Hello" }],
        });
        return result;
      })
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsAI).toBe(true);
    expect(result.needsD1).toBe(false);
  });

  it('detects c.env.AI access', () => {
    const code = `
      export const POST = defineHandler(async (c) => {
        const result = await c.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
          messages: [{ role: "user", content: "Hello" }],
        });
        return c.json(result);
      })
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsAI).toBe(true);
  });

  it("detects import { getSandbox } from 'void/sandbox'", () => {
    const code = `
      import { getSandbox } from "void/sandbox";
      export const POST = defineHandler(async () => {
        const sandbox = getSandbox("session-1");
        return sandbox.exec("node --version");
      })
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsSandbox).toBe(true);
  });

  it('detects c.env.SANDBOX access', () => {
    const code = `
      export const POST = defineHandler(async (c) => {
        const id = c.env.SANDBOX.idFromName("session-1");
        return c.env.SANDBOX.get(id);
      })
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsSandbox).toBe(true);
  });

  it('detects env.AI access', () => {
    const code = `
      export async function handler(request, env) {
        return Response.json(await env.AI.run("@cf/meta/llama-3.1-8b-instruct", { prompt: "Hi" }))
      }
    `;
    const result = inferBindingsFromSource(code, 'main.ssr.ts');
    expect(result.needsAI).toBe(true);
  });

  it("detects import { sendEmail } from 'void/email'", () => {
    const code = `
      import { sendEmail } from "void/email";
      export const POST = defineHandler(async () => {
        await sendEmail({ from: "a@x.dev", to: "b@y.dev", subject: "hi", text: "hi" });
      })
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsEmail).toBe(true);
  });

  it('does NOT detect c.env.SEND_EMAIL access (binding lives on the proxy, not the user worker)', () => {
    // SEND_EMAIL is intentionally absent from the env-binding regex —
    // outbound email routes through __VOID_PROXY/email/send, so a user
    // worker accessing `env.SEND_EMAIL` will get undefined regardless of
    // whether we'd inferred the import. Inference is now solely driven
    // by `void/email` import-source detection.
    const code = `
      export const POST = defineHandler(async (c) => {
        return c.env.SEND_EMAIL.send(message);
      })
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsEmail).toBe(false);
  });

  it('does not detect needsAI from unrelated identifiers', () => {
    const code = `
      const AI = someLibrary;
      export const GET = defineHandler(() => {
        return { status: 'ok' }
      })
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsAI).toBe(false);
  });

  it("detects non-type imports from 'void/live'", () => {
    const code = `
      import { defineLiveStream } from "void/live";
      export const live = defineLiveStream({ id: "app" });
    `;
    const result = inferBindingsFromSource(code, 'live.ts');
    expect(result.needsLive).toBe(true);
  });

  it("does not detect live infrastructure from 'void/live/client'", () => {
    const code = `
      import { connectLiveStream } from "void/live/client";
      connectLiveStream("/live");
    `;
    const result = inferBindingsFromSource(code, 'client.ts');
    expect(result.needsLive).toBe(false);
  });

  it("does not detect live infrastructure from type-only 'void/live' imports", () => {
    const code = `
      import type { LiveClientEvent } from "void/live";
      export type Event = LiveClientEvent<{ value: string }>;
    `;
    const result = inferBindingsFromSource(code, 'types.ts');
    expect(result.needsLive).toBe(false);
  });

  it("does not detect live infrastructure from inline type-only 'void/live' imports", () => {
    const code = `
      import { type LiveStream, type LiveClientEvent } from "void/live";
      export type Stream = LiveStream;
      export type Event = LiveClientEvent<{ value: string }>;
    `;
    const result = inferBindingsFromSource(code, 'types.ts');
    expect(result.needsLive).toBe(false);
  });

  it("detects live infrastructure from mixed inline type and value 'void/live' imports", () => {
    const code = `
      import { type LiveStream, defineLiveStream } from "void/live";
      export type Stream = LiveStream;
      export const live = defineLiveStream({ id: "app" });
    `;
    const result = inferBindingsFromSource(code, 'live.ts');
    expect(result.needsLive).toBe(true);
  });
});

describe('mergeBindings', () => {
  const empty = {
    needsD1: false,
    needsKV: false,
    needsR2: false,
    needsAuth: false,
    needsQueues: false,
    needsAI: false,
    needsSandbox: false,
  };

  it('merges multiple binding results (union)', () => {
    const result = mergeBindings([
      { ...empty, needsD1: true },
      { ...empty, needsKV: true },
      { ...empty, needsR2: true },
    ]);
    expect(result.needsD1).toBe(true);
    expect(result.needsKV).toBe(true);
    expect(result.needsR2).toBe(true);
    expect(result.needsAuth).toBe(false);
    expect(result.needsAI).toBe(false);
  });

  it('handles empty array', () => {
    const result = mergeBindings([]);
    expect(result.needsD1).toBe(false);
    expect(result.needsKV).toBe(false);
    expect(result.needsR2).toBe(false);
    expect(result.needsAuth).toBe(false);
    expect(result.needsAI).toBe(false);
  });

  it('merges auth flag', () => {
    const result = mergeBindings([empty, { ...empty, needsAuth: true }]);
    expect(result.needsAuth).toBe(true);
  });

  it('merges queues flag', () => {
    const result = mergeBindings([empty, { ...empty, needsQueues: true }]);
    expect(result.needsQueues).toBe(true);
  });

  it('merges AI flag', () => {
    const result = mergeBindings([empty, { ...empty, needsAI: true }]);
    expect(result.needsAI).toBe(true);
  });

  it('merges sandbox flag', () => {
    const result = mergeBindings([empty, { ...empty, needsSandbox: true }]);
    expect(result.needsSandbox).toBe(true);
  });

  it('merges live flag', () => {
    const result = mergeBindings([empty, { ...empty, needsLive: true }]);
    expect(result.needsLive).toBe(true);
  });

  it('merges AI with other bindings', () => {
    const result = mergeBindings([
      { ...empty, needsD1: true },
      { ...empty, needsAI: true },
    ]);
    expect(result.needsD1).toBe(true);
    expect(result.needsAI).toBe(true);
    expect(result.needsKV).toBe(false);
  });
});
