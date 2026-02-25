import { describe, expect, it, vi } from "vitest";

import { defer, separateDeferred, DEFERRED } from "../../src/pages/defer";

describe("defer", () => {
  it("single prop — returns sentinel with null group", () => {
    const resolver = vi.fn();
    const result = defer(resolver) as any;
    expect(result[DEFERRED]).toBe(true);
    expect(result.group).toBeNull();
    expect(result.resolver).toBe(resolver);
  });

  it("named group — returns sentinel with group name", () => {
    const resolver = vi.fn();
    const result = defer("analytics", resolver) as any;
    expect(result[DEFERRED]).toBe(true);
    expect(result.group).toBe("analytics");
    expect(result.resolver).toBe(resolver);
  });
});

describe("separateDeferred", () => {
  it("returns all immediate props when no deferred", () => {
    const input = { projects: [1, 2], title: "Hello" };
    const { immediateProps, deferredMap } = separateDeferred(input);
    expect(immediateProps).toEqual({ projects: [1, 2], title: "Hello" });
    expect(deferredMap).toEqual({});
  });

  const LOADING = { value: null, loading: true, error: null };

  it("separates single deferred prop — uses object key as group", () => {
    const resolver = vi.fn();
    const input = {
      projects: [1, 2],
      usage: { [DEFERRED]: true, group: null, resolver },
    };
    const { immediateProps, deferredMap } = separateDeferred(input);
    expect(immediateProps).toEqual({ projects: [1, 2], usage: LOADING });
    expect(Object.keys(deferredMap)).toEqual(["usage"]);
    expect(deferredMap["usage"].resolver).toBe(resolver);
    expect(deferredMap["usage"].keys).toEqual(["usage"]);
  });

  it("separates named group — groups by group name", () => {
    const resolver = vi.fn();
    const input = {
      projects: [1, 2],
      metrics: { [DEFERRED]: true, group: "analytics", resolver },
      chart: { [DEFERRED]: true, group: "analytics", resolver },
    };
    const { immediateProps, deferredMap } = separateDeferred(input);
    expect(immediateProps).toEqual({
      projects: [1, 2],
      metrics: LOADING,
      chart: LOADING,
    });
    expect(Object.keys(deferredMap)).toEqual(["analytics"]);
    expect(deferredMap["analytics"].keys).toEqual(["metrics", "chart"]);
    expect(deferredMap["analytics"].resolver).toBe(resolver);
  });

  it("handles mix of immediate, single deferred, and grouped deferred", () => {
    const usageResolver = vi.fn();
    const analyticsResolver = vi.fn();
    const input = {
      projects: [1],
      usage: { [DEFERRED]: true, group: null, resolver: usageResolver },
      metrics: {
        [DEFERRED]: true,
        group: "analytics",
        resolver: analyticsResolver,
      },
      chart: {
        [DEFERRED]: true,
        group: "analytics",
        resolver: analyticsResolver,
      },
    };
    const { immediateProps, deferredMap } = separateDeferred(input);
    expect(immediateProps).toEqual({
      projects: [1],
      usage: LOADING,
      metrics: LOADING,
      chart: LOADING,
    });
    expect(Object.keys(deferredMap).sort()).toEqual(["analytics", "usage"]);
    expect(deferredMap["usage"].keys).toEqual(["usage"]);
    expect(deferredMap["analytics"].keys).toEqual(["metrics", "chart"]);
  });
});
