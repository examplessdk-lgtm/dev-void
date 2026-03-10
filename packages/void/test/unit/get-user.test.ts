import { describe, expect, it } from "vitest";
import {
  getSession,
  getUser,
  authContext,
  type AuthState,
  type AuthUser,
} from "../../src/runtime/auth";

function createUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: "u1",
    createdAt: new Date("2026-03-09T00:00:00Z"),
    updatedAt: new Date("2026-03-09T00:00:00Z"),
    email: "test@example.com",
    emailVerified: true,
    name: "Test User",
    image: null,
    ...overrides,
  };
}

function createState(user: AuthUser = createUser()): AuthState {
  return {
    user,
    session: {
      id: "s1",
      createdAt: new Date("2026-03-09T00:00:00Z"),
      updatedAt: new Date("2026-03-09T00:00:00Z"),
      token: "token",
      expiresAt: new Date("2026-03-10T00:00:00Z"),
      ipAddress: null,
      userAgent: null,
      userId: user.id,
    },
  };
}

describe("getUser", () => {
  it("returns null outside ALS context", () => {
    expect(getUser()).toBeNull();
  });

  it("returns null when user is null", () => {
    authContext.run({ user: null, state: null }, () => {
      expect(getUser()).toBeNull();
    });
  });

  it("returns user from ALS context", () => {
    const user = createUser();
    authContext.run({ user, state: createState(user) }, () => {
      expect(getUser()).toBe(user);
    });
  });
});

describe("getSession", () => {
  it("returns null outside ALS context", () => {
    expect(getSession()).toBeNull();
  });

  it("returns the auth state from ALS context", () => {
    const user = createUser();
    const state = createState(user);
    authContext.run({ user, state }, () => {
      expect(getSession()).toBe(state);
    });
  });
});
