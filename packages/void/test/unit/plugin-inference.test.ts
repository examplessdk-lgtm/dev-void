import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inferProjectBindings, detectFramework } from "../../src/plugin-inference";

const tempDirs: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "void-inference-"));
  tempDirs.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  return root;
}

describe("inferProjectBindings", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("infers bindings from src/main.ssr.tsx", () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, "src", "main.ssr.tsx"),
      `
      export async function render(request, env) {
        await env.KV.put("k", "v");
        return new Response("ok");
      }
      `,
    );

    expect(inferProjectBindings(root)).toEqual({
      needsD1: false,
      needsKV: true,
      needsR2: false,
      needsAuth: false,
      needsQueues: false,
      needsAI: false,
    });
  });

  it("detects auth from void/client import with auth specifier in src/", () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, "src", "App.tsx"),
      `
      import { auth, AuthError } from "void/client";
      export default function App() {
        auth.me();
      }
      `,
    );

    const result = inferProjectBindings(root);
    expect(result.needsAuth).toBe(true);
  });

  it("detects auth from void/auth import in routes/", () => {
    const root = createTempRoot();
    mkdirSync(join(root, "routes", "api"), { recursive: true });
    writeFileSync(
      join(root, "routes", "api", "profile.ts"),
      `
      import { requireAuth } from "void/auth";
      export const GET = (c) => {
        const user = requireAuth(c);
        return { user };
      };
      `,
    );

    const result = inferProjectBindings(root);
    expect(result.needsAuth).toBe(true);
  });

  it("does not detect auth from void/client with only fetch", () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, "src", "App.tsx"),
      `
      import { fetch } from "void/client";
      export default function App() {
        fetch("/api/hello");
      }
      `,
    );

    const result = inferProjectBindings(root);
    expect(result.needsAuth).toBe(false);
  });

  it("detects bindings from pages/ .server.ts files", () => {
    const root = createTempRoot();
    mkdirSync(join(root, "pages"), { recursive: true });
    writeFileSync(
      join(root, "pages", "index.server.ts"),
      `
      import { db } from "void/db";
      export function loader() {
        return db.select().from(users);
      }
      `,
    );

    const result = inferProjectBindings(root);
    expect(result.needsD1).toBe(true);
  });

  it("does not scan src/ twice in framework mode", () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, "src", "App.tsx"),
      `
      import { auth } from "void/client";
      `,
    );

    // When scanDirs already includes "src", it should not double-scan
    const result = inferProjectBindings(root, undefined, ["src", "routes"]);
    expect(result.needsAuth).toBe(true);
  });

  it("detects bindings from .astro frontmatter", () => {
    const root = createTempRoot();
    mkdirSync(join(root, "src", "pages"), { recursive: true });
    writeFileSync(
      join(root, "src", "pages", "smoke.astro"),
      `---
import { db } from "void/db";
import { kv } from "void/kv";
const row = await Astro.locals.runtime.env.DB.prepare("SELECT 1").first();
---
<h1>{row ? "ok" : "none"}</h1>
`,
    );

    const result = inferProjectBindings(root);
    expect(result.needsD1).toBe(true);
    expect(result.needsKV).toBe(true);
  });

  it("ignores env.* references outside Astro frontmatter", () => {
    const root = createTempRoot();
    mkdirSync(join(root, "src", "pages"), { recursive: true });
    writeFileSync(
      join(root, "src", "pages", "index.astro"),
      `
<script>
  console.log(env.DB);
</script>
`,
    );

    const result = inferProjectBindings(root);
    expect(result.needsD1).toBe(false);
    expect(result.needsKV).toBe(false);
  });
});

describe("detectFramework", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects vinext-pages when no app/ directory", () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { vinext: "^0.0.5", react: "^19.0.0" } }),
    );
    const result = detectFramework(root);
    expect(result).toEqual({ name: "vinext-pages", class: "a" });
  });

  it("detects vinext-app when app/ directory exists", () => {
    const root = createTempRoot();
    mkdirSync(join(root, "app"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { vinext: "^0.0.5", react: "^19.0.0" } }),
    );
    const result = detectFramework(root);
    expect(result).toEqual({ name: "vinext-app", class: "a" });
  });

  it("detects vinext-pages from devDependencies", () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ devDependencies: { vinext: "^0.0.5" } }),
    );
    const result = detectFramework(root);
    expect(result).toEqual({ name: "vinext-pages", class: "a" });
  });
});
