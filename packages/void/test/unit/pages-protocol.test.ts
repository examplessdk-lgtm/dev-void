import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  handlePageGet,
  handlePageMutation,
  flattenValidationErrors,
  ValidationError,
} from "../../src/pages/protocol";
import { defer } from "../../src/pages/defer";

/** Create a minimal Hono context for testing */
function createTestContext(
  method: string,
  path: string,
  options: {
    headers?: Record<string, string>;
    shared?: Record<string, unknown>;
  } = {},
): Promise<any> {
  const app = new Hono();
  let resolveContext: (c: any) => void;
  const contextPromise = new Promise<any>((resolve) => {
    resolveContext = resolve;
  });

  app.use(async (c, next) => {
    if (options.shared) {
      (c as any).set("shared", options.shared);
    }
    await next();
  });

  app.all("*", (c) => {
    resolveContext!(c);
    return c.text("ok");
  });

  const url = `http://localhost${path}`;
  const req = new Request(url, { method, headers: options.headers });
  app.fetch(req);

  return contextPromise;
}

const mockRenderFn = vi.fn(async (pageObj: any) => `<html>${pageObj.component}</html>`);
const mockGetAssetTags = vi.fn(async () => ({ css: "", preloads: "", body: "" }));

describe("handlePageGet", () => {
  it("returns JSON page object when X-VoidPages header present", async () => {
    const c = await createTestContext("GET", "/users", {
      headers: { "x-voidpages": "true" },
    });

    const handler = vi.fn(() => ({ users: [1, 2, 3] }));
    const response = await handlePageGet(
      handler,
      undefined,
      c,
      "users",
      mockRenderFn,
      mockGetAssetTags,
    );

    expect(response.headers.get("X-VoidPages")).toBe("true");
    expect(response.headers.get("Vary")).toBe("X-VoidPages");
    const body = (await response.json()) as any;
    expect(body.component).toBe("users");
    expect(body.props).toEqual({ users: [1, 2, 3] });
    expect(body.url).toBe("/users");
    expect(body.errors).toBeNull();
  });

  it("calls renderFn and returns HTML when no X-VoidPages header", async () => {
    const c = await createTestContext("GET", "/users");

    const handler = vi.fn(() => ({ users: [] }));
    const response = await handlePageGet(
      handler,
      undefined,
      c,
      "users",
      mockRenderFn,
      mockGetAssetTags,
    );

    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await response.text();
    expect(html).toContain("users");
  });

  it("handles undefined handler (empty props)", async () => {
    const c = await createTestContext("GET", "/", {
      headers: { "x-voidpages": "true" },
    });

    const response = await handlePageGet(
      undefined,
      undefined,
      c,
      "index",
      mockRenderFn,
      mockGetAssetTags,
    );

    const body = (await response.json()) as any;
    expect(body.props).toEqual({});
    expect(body.component).toBe("index");
  });

  it("passes through redirect Response from loader", async () => {
    const c = await createTestContext("GET", "/auth/callback");

    const redirect = new Response(null, {
      status: 302,
      headers: { Location: "/" },
    });
    const handler = vi.fn(() => redirect);
    const renderFn = vi.fn(async (pageObj: any) => `<html>${pageObj.component}</html>`);
    const response = await handlePageGet(
      handler,
      undefined,
      c,
      "callback",
      renderFn,
      mockGetAssetTags,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/");
    expect(renderFn).not.toHaveBeenCalled();
  });

  it("island=true always renders HTML even with X-VoidPages header", async () => {
    const c = await createTestContext("GET", "/", {
      headers: { "x-voidpages": "true" },
    });

    const renderFn = vi.fn(async () => "<html>island</html>");
    const response = await handlePageGet(
      undefined,
      undefined,
      c,
      "index",
      renderFn,
      mockGetAssetTags,
      undefined,
      true,
    );

    expect(response.headers.get("content-type")).toContain("text/html");
    expect(renderFn).toHaveBeenCalled();
  });

  it("island=false returns JSON for X-VoidPages requests (unchanged)", async () => {
    const c = await createTestContext("GET", "/", {
      headers: { "x-voidpages": "true" },
    });

    const renderFn = vi.fn(async () => "<html></html>");
    const response = await handlePageGet(
      undefined,
      undefined,
      c,
      "index",
      renderFn,
      mockGetAssetTags,
      undefined,
      false,
    );

    expect(response.headers.get("X-VoidPages")).toBe("true");
    expect(renderFn).not.toHaveBeenCalled();
  });

  it("includes shared data from context", async () => {
    const c = await createTestContext("GET", "/", {
      headers: { "x-voidpages": "true" },
      shared: { auth: { user: { name: "Test" } } },
    });

    const response = await handlePageGet(
      undefined,
      undefined,
      c,
      "index",
      mockRenderFn,
      mockGetAssetTags,
    );

    const body = (await response.json()) as any;
    expect(body.shared).toEqual({ auth: { user: { name: "Test" } } });
  });

  it("prefetch request — resolves deferred props inline as plain JSON", async () => {
    const c = await createTestContext("GET", "/dashboard", {
      headers: { "x-voidpages": "true", purpose: "prefetch" },
    });

    const handler = vi.fn(() => ({
      stats: { count: 42 },
      usage: defer(async () => ({ requests: 1200 })),
    }));

    const response = await handlePageGet(
      handler,
      undefined,
      c,
      "dashboard",
      mockRenderFn,
      mockGetAssetTags,
    );

    expect(response.headers.get("content-type")).not.toContain("ndjson");
    expect(response.headers.get("X-VoidPages")).toBe("true");

    const body = (await response.json()) as any;
    expect(body.props.usage).toEqual({ requests: 1200 });
    expect(body.deferred).toBeUndefined();
    // deferredKeys is preserved so clients can wrap resolved values
    expect(body.deferredKeys).toEqual({ usage: "usage" });
  });
});

describe("handlePageMutation", () => {
  it("void return — re-runs GET, returns fresh props", async () => {
    const c = await createTestContext("POST", "/users", {
      headers: { "x-voidpages": "true" },
    });

    const mutationHandler = vi.fn(() => undefined);
    const getHandler = vi.fn(() => ({ users: ["new"] }));

    const response = await handlePageMutation(
      mutationHandler,
      getHandler,
      undefined,
      c,
      "users",
      mockRenderFn,
      mockGetAssetTags,
    );

    const body = (await response.json()) as any;
    expect(body.props).toEqual({ users: ["new"] });
    expect(body.errors).toBeNull();
  });

  it("Response redirect — passes through", async () => {
    const c = await createTestContext("POST", "/users", {
      headers: { "x-voidpages": "true" },
    });

    const redirect = new Response(null, {
      status: 302,
      headers: { Location: "/users/1" },
    });
    const mutationHandler = vi.fn(() => redirect);

    const response = await handlePageMutation(
      mutationHandler,
      undefined,
      undefined,
      c,
      "users",
      mockRenderFn,
      mockGetAssetTags,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/users/1");
  });

  it("ValidationError thrown — re-runs GET with errors", async () => {
    const c = await createTestContext("POST", "/users", {
      headers: { "x-voidpages": "true" },
    });

    const mutationHandler = vi.fn(() => {
      throw new ValidationError({ name: "required" });
    });
    const getHandler = vi.fn(() => ({ users: [] }));

    const response = await handlePageMutation(
      mutationHandler,
      getHandler,
      undefined,
      c,
      "users",
      mockRenderFn,
      mockGetAssetTags,
    );

    const body = (await response.json()) as any;
    expect(body.errors).toEqual({ name: "required" });
    expect(body.props).toEqual({ users: [] });
  });

  it("Response 400 (withValidator) — extracts errors, re-runs GET", async () => {
    const c = await createTestContext("POST", "/users", {
      headers: { "x-voidpages": "true" },
    });

    const validationResponse = Response.json(
      {
        issues: [
          {
            slot: "body",
            issues: [{ message: "required", path: "name" }],
          },
        ],
      },
      { status: 400 },
    );
    const mutationHandler = vi.fn(() => validationResponse);
    const getHandler = vi.fn(() => ({ users: [] }));

    const response = await handlePageMutation(
      mutationHandler,
      getHandler,
      undefined,
      c,
      "users",
      mockRenderFn,
      mockGetAssetTags,
    );

    const body = (await response.json()) as any;
    expect(body.errors).toEqual({ name: "required" });
  });

  it("Response 204 (void from withValidator) — re-runs GET", async () => {
    const c = await createTestContext("POST", "/users", {
      headers: { "x-voidpages": "true" },
    });

    const voidResponse = new Response(null, { status: 204 });
    const mutationHandler = vi.fn(() => voidResponse);
    const getHandler = vi.fn(() => ({ users: ["created"] }));

    const response = await handlePageMutation(
      mutationHandler,
      getHandler,
      undefined,
      c,
      "users",
      mockRenderFn,
      mockGetAssetTags,
    );

    const body = (await response.json()) as any;
    expect(body.props).toEqual({ users: ["created"] });
    expect(body.errors).toBeNull();
  });

  it("re-throws non-ValidationError errors", async () => {
    const c = await createTestContext("POST", "/users", {
      headers: { "x-voidpages": "true" },
    });

    const mutationHandler = vi.fn(() => {
      throw new Error("boom");
    });

    await expect(
      handlePageMutation(
        mutationHandler,
        undefined,
        undefined,
        c,
        "users",
        mockRenderFn,
        mockGetAssetTags,
      ),
    ).rejects.toThrow("boom");
  });

  it("island mutation — ValidationError returns JSON 422", async () => {
    const c = await createTestContext("POST", "/contact");

    const mutationHandler = vi.fn(() => {
      throw new ValidationError({ email: "required" });
    });

    const response = await handlePageMutation(
      mutationHandler,
      undefined,
      undefined,
      c,
      "contact",
      mockRenderFn,
      mockGetAssetTags,
      undefined,
      true,
    );

    expect(response.status).toBe(422);
    const body = (await response.json()) as any;
    expect(body.errors).toEqual({ email: "required" });
  });

  it("island mutation — withValidator 400 returns JSON 422", async () => {
    const c = await createTestContext("POST", "/contact");

    const validationResponse = Response.json(
      {
        issues: [
          {
            slot: "body",
            issues: [{ message: "required", path: "email" }],
          },
        ],
      },
      { status: 400 },
    );
    const mutationHandler = vi.fn(() => validationResponse);

    const response = await handlePageMutation(
      mutationHandler,
      undefined,
      undefined,
      c,
      "contact",
      mockRenderFn,
      mockGetAssetTags,
      undefined,
      true,
    );

    expect(response.status).toBe(422);
    const body = (await response.json()) as any;
    expect(body.errors).toEqual({ email: "required" });
  });

  it("island mutation — success returns JSON 200", async () => {
    const c = await createTestContext("POST", "/contact");

    const mutationHandler = vi.fn(() => undefined);

    const response = await handlePageMutation(
      mutationHandler,
      undefined,
      undefined,
      c,
      "contact",
      mockRenderFn,
      mockGetAssetTags,
      undefined,
      true,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.success).toBe(true);
  });

  it("island mutation — redirect passes through", async () => {
    const c = await createTestContext("POST", "/contact");

    const redirect = new Response(null, {
      status: 302,
      headers: { Location: "/dashboard" },
    });
    const mutationHandler = vi.fn(() => redirect);

    const response = await handlePageMutation(
      mutationHandler,
      undefined,
      undefined,
      c,
      "contact",
      mockRenderFn,
      mockGetAssetTags,
      undefined,
      true,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/dashboard");
  });
});

describe("handlePageGet with deferred props", () => {
  it("SPA — streams NDJSON with immediate props first, then deferred", async () => {
    const c = await createTestContext("GET", "/dashboard", {
      headers: { "x-voidpages": "true" },
    });

    const handler = vi.fn(() => ({
      projects: [1, 2],
      usage: defer(() => Promise.resolve({ requests: 100 })),
    }));

    const response = await handlePageGet(
      handler,
      undefined,
      c,
      "dashboard",
      mockRenderFn,
      mockGetAssetTags,
    );

    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    const text = await response.text();
    const lines = text.trim().split("\n");
    expect(lines.length).toBe(2);

    const pageObj = JSON.parse(lines[0]);
    expect(pageObj.props).toEqual({
      projects: [1, 2],
      usage: { value: null, loading: true, error: null },
    });
    expect(pageObj.deferred).toEqual(["usage"]);
    expect(pageObj.deferredKeys).toEqual({ usage: "usage" });

    const deferredLine = JSON.parse(lines[1]);
    expect(deferredLine.__deferred).toBe("usage");
    expect(deferredLine.data).toEqual({ requests: 100 });
  });

  it("SPA — streams error for failed deferred resolver", async () => {
    const c = await createTestContext("GET", "/dashboard", {
      headers: { "x-voidpages": "true" },
    });

    const handler = vi.fn(() => ({
      projects: [],
      usage: defer(() => Promise.reject(new Error("timeout"))),
    }));

    const response = await handlePageGet(
      handler,
      undefined,
      c,
      "dashboard",
      mockRenderFn,
      mockGetAssetTags,
    );

    const text = await response.text();
    const lines = text.trim().split("\n");
    expect(lines.length).toBe(2);

    const deferredLine = JSON.parse(lines[1]);
    expect(deferredLine.__deferred).toBe("usage");
    expect(deferredLine.error).toBe("timeout");
  });

  it("SPA — no deferred props returns normal JSON (not streaming)", async () => {
    const c = await createTestContext("GET", "/users", {
      headers: { "x-voidpages": "true" },
    });

    const handler = vi.fn(() => ({ users: [1] }));
    const response = await handlePageGet(
      handler,
      undefined,
      c,
      "users",
      mockRenderFn,
      mockGetAssetTags,
    );

    const body = (await response.json()) as any;
    expect(body.props).toEqual({ users: [1] });
    expect(body.deferred).toBeUndefined();
  });

  it("SSR — streams HTML then deferred script tags", async () => {
    const c = await createTestContext("GET", "/dashboard");

    const handler = vi.fn(() => ({
      projects: [1],
      usage: defer(() => Promise.resolve({ requests: 100 })),
    }));

    const renderFn = vi.fn(
      async (pageObj: any) =>
        `<script id="__VOID_PAGE_DATA__" type="application/json">${JSON.stringify(pageObj)}</script><div id="app"></div>`,
    );

    const response = await handlePageGet(
      handler,
      undefined,
      c,
      "dashboard",
      renderFn,
      mockGetAssetTags,
    );

    const text = await response.text();
    expect(text).toContain("__VOID_PAGE_DATA__");
    expect(text).toContain('"deferred":["usage"]');
    expect(text).toContain('window.__resolveDeferred("usage",');
    expect(text).toContain('"requests":100');
  });

  it("SSR — no deferred props returns normal HTML", async () => {
    const c = await createTestContext("GET", "/users");

    const handler = vi.fn(() => ({ users: [1] }));
    const response = await handlePageGet(
      handler,
      undefined,
      c,
      "users",
      mockRenderFn,
      mockGetAssetTags,
    );

    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("deferred named group — resolves all keys together", async () => {
    const c = await createTestContext("GET", "/dashboard", {
      headers: { "x-voidpages": "true" },
    });

    const analyticsResolver = () =>
      Promise.resolve({ metrics: { count: 5 }, chart: { data: [1] } });

    const analytics = defer("analytics", analyticsResolver);
    const handler = vi.fn(() => ({
      projects: [1],
      metrics: analytics,
      chart: analytics,
    }));

    const response = await handlePageGet(
      handler,
      undefined,
      c,
      "dashboard",
      mockRenderFn,
      mockGetAssetTags,
    );

    const text = await response.text();
    const lines = text.trim().split("\n");
    expect(lines.length).toBe(2);

    const pageObj = JSON.parse(lines[0]);
    expect(pageObj.deferred).toEqual(["analytics"]);
    expect(pageObj.deferredKeys).toEqual({ metrics: "analytics", chart: "analytics" });

    const deferredLine = JSON.parse(lines[1]);
    expect(deferredLine.__deferred).toBe("analytics");
    expect(deferredLine.data).toHaveProperty("metrics");
    expect(deferredLine.data).toHaveProperty("chart");
  });

  it("redirect from loader with deferred props — passes through", async () => {
    const c = await createTestContext("GET", "/dashboard");

    const redirect = new Response(null, {
      status: 302,
      headers: { Location: "/login" },
    });
    const handler = vi.fn(() => redirect);
    const response = await handlePageGet(
      handler,
      undefined,
      c,
      "dashboard",
      mockRenderFn,
      mockGetAssetTags,
    );

    expect(response.status).toBe(302);
  });
});

describe("flattenValidationErrors", () => {
  it("flattens nested issues format into flat map", () => {
    const body = {
      issues: [
        {
          slot: "body",
          issues: [
            { message: "required", path: "name" },
            { message: "invalid", path: "email" },
          ],
        },
      ],
    };

    expect(flattenValidationErrors(body)).toEqual({
      name: "required",
      email: "invalid",
    });
  });

  it("uses slot as key fallback when no path", () => {
    const body = {
      issues: [
        {
          slot: "body",
          issues: [{ message: "invalid body" }],
        },
      ],
    };

    expect(flattenValidationErrors(body)).toEqual({
      body: "invalid body",
    });
  });

  it("returns empty object for null/undefined input", () => {
    expect(flattenValidationErrors(null)).toEqual({});
    expect(flattenValidationErrors(undefined)).toEqual({});
  });
});
