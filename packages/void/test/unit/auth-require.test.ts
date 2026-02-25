import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";

import { requireAuth, type AuthUser } from "../../src/runtime/auth";

function mockContext(user: AuthUser | null) {
  return {
    get(key: string) {
      if (key === "user") return user;
      return undefined;
    },
  } as any;
}

describe("requireAuth", () => {
  it("returns user when present", () => {
    const user: AuthUser = {
      id: "u1",
      provider: "email",
      email: "test@test.com",
      name: "Test",
      avatar_url: null,
    };
    expect(requireAuth(mockContext(user))).toBe(user);
  });

  it("throws HTTPException 401 when user is null", () => {
    expect(() => requireAuth(mockContext(null))).toThrow(HTTPException);
    expect(() => requireAuth(mockContext(null))).toThrow("Unauthorized");
  });
});
