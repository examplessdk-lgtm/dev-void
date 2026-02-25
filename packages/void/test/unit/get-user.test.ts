import { describe, expect, it } from "vitest";

import { getUser, authContext, type AuthUser } from "../../src/runtime/auth";

describe("getUser", () => {
  it("returns null outside ALS context", () => {
    expect(getUser()).toBeNull();
  });

  it("returns null when user is null", () => {
    authContext.run({ user: null }, () => {
      expect(getUser()).toBeNull();
    });
  });

  it("returns user from ALS context", () => {
    const user: AuthUser = {
      id: "u1",
      provider: "github",
      email: "test@example.com",
      name: "Test User",
      avatar_url: null,
    };
    authContext.run({ user }, () => {
      expect(getUser()).toBe(user);
    });
  });
});
