import { describe, expect, it, vi } from "vitest";

const { createAuthClientMock } = vi.hoisted(() => ({
  createAuthClientMock: vi.fn((options?: unknown) => ({ options })),
}));

vi.mock("better-auth/client", () => ({
  createAuthClient: createAuthClientMock,
}));

import { auth, createAuthClient } from "../../src/runtime/auth-client";

describe("auth-client runtime", () => {
  it("re-exports Better Auth's createAuthClient", () => {
    expect(createAuthClient).toBe(createAuthClientMock);
  });

  it("creates the default auth client with Void's base path", () => {
    expect(createAuthClientMock).toHaveBeenCalledWith({ basePath: "/api/auth" });
    expect(auth).toEqual({ options: { basePath: "/api/auth" } });
  });
});
