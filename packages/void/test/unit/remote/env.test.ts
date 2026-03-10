import { describe, it, expect } from "vitest";
import { createRemoteEnv } from "../../../src/runtime/remote/index";
import { ProxyD1Database } from "../../../src/runtime/remote/d1";
import { ProxyKVNamespace } from "../../../src/runtime/remote/kv";
import { ProxyR2Bucket } from "../../../src/runtime/remote/r2";

const BASE_ENV: Record<string, unknown> = {
  __VOID_PROXY_URL: "https://proxy.void.cloud",
  __VOID_TOKEN: "test-token",
  __VOID_PROJECT_ID: "proj_1",
  __VOID_REMOTE: "1",
};

describe("createRemoteEnv", () => {
  it("replaces DB with ProxyD1Database", () => {
    const env = createRemoteEnv({ ...BASE_ENV, DB: {} });
    expect(env.DB).toBeInstanceOf(ProxyD1Database);
  });

  it("replaces KV with ProxyKVNamespace", () => {
    const env = createRemoteEnv({ ...BASE_ENV, KV: {} });
    expect(env.KV).toBeInstanceOf(ProxyKVNamespace);
  });

  it("replaces STORAGE with ProxyR2Bucket", () => {
    const env = createRemoteEnv({ ...BASE_ENV, STORAGE: {} });
    expect(env.STORAGE).toBeInstanceOf(ProxyR2Bucket);
  });

  it("does not add bindings that are not in env", () => {
    const env = createRemoteEnv({ ...BASE_ENV });
    expect(env.DB).toBeUndefined();
    expect(env.KV).toBeUndefined();
    expect(env.STORAGE).toBeUndefined();
  });

  it("preserves other env properties", () => {
    const env = createRemoteEnv({ ...BASE_ENV, DB: {}, CUSTOM_VAR: "hello" });
    expect(env.CUSTOM_VAR).toBe("hello");
    expect(env.__VOID_PROXY_URL).toBe("https://proxy.void.cloud");
  });

  it("replaces all bindings when all are present", () => {
    const env = createRemoteEnv({
      ...BASE_ENV,
      DB: {},
      KV: {},
      STORAGE: {},
    });
    expect(env.DB).toBeInstanceOf(ProxyD1Database);
    expect(env.KV).toBeInstanceOf(ProxyKVNamespace);
    expect(env.STORAGE).toBeInstanceOf(ProxyR2Bucket);
  });
});
