import { describe, it, expect } from "vitest";

describe("internal binding filtering", () => {
  function filterInternalBindings(env: Record<string, unknown>): Record<string, unknown> {
    return new Proxy(env, {
      get(target, prop) {
        if (
          typeof prop === "string" &&
          (prop.startsWith("__VOID_") || prop.startsWith("__PROJECT_"))
        ) {
          return undefined;
        }
        return Reflect.get(target, prop);
      },
      has(target, prop) {
        if (
          typeof prop === "string" &&
          (prop.startsWith("__VOID_") || prop.startsWith("__PROJECT_"))
        ) {
          return false;
        }
        return Reflect.has(target, prop);
      },
      ownKeys(target) {
        return Reflect.ownKeys(target).filter(
          (key) =>
            typeof key !== "string" ||
            (!key.startsWith("__VOID_") && !key.startsWith("__PROJECT_")),
        );
      },
      getOwnPropertyDescriptor(target, prop) {
        if (
          typeof prop === "string" &&
          (prop.startsWith("__VOID_") || prop.startsWith("__PROJECT_"))
        ) {
          return undefined;
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    });
  }

  it("hides __VOID_ prefixed bindings", () => {
    const env = { DB: {}, __VOID_PROXY_TOKEN: "secret", __VOID_PROXY: {} };
    const filtered = filterInternalBindings(env);
    expect(filtered.DB).toBeDefined();
    expect(filtered.__VOID_PROXY_TOKEN).toBeUndefined();
    expect(filtered.__VOID_PROXY).toBeUndefined();
  });

  it("hides __PROJECT_ prefixed bindings", () => {
    const env = { KV: {}, __PROJECT_ID: "proj_123" };
    const filtered = filterInternalBindings(env);
    expect(filtered.KV).toBeDefined();
    expect(filtered.__PROJECT_ID).toBeUndefined();
  });

  it("excludes internal keys from ownKeys", () => {
    const env = { DB: {}, __VOID_PROXY_TOKEN: "secret", __PROJECT_ID: "proj_123" };
    const filtered = filterInternalBindings(env);
    expect(Object.keys(filtered)).toEqual(["DB"]);
  });

  it("excludes internal keys from has check", () => {
    const env = { __VOID_PROXY_TOKEN: "secret", DB: {} };
    const filtered = filterInternalBindings(env);
    expect("DB" in filtered).toBe(true);
    expect("__VOID_PROXY_TOKEN" in filtered).toBe(false);
  });

  it("preserves user bindings", () => {
    const env = { DB: "d1-binding", KV: "kv-binding", STORAGE: "r2-binding", MY_VAR: "hello" };
    const filtered = filterInternalBindings(env);
    expect(filtered.DB).toBe("d1-binding");
    expect(filtered.KV).toBe("kv-binding");
    expect(filtered.STORAGE).toBe("r2-binding");
    expect(filtered.MY_VAR).toBe("hello");
  });
});
