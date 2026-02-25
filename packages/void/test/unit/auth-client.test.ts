import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { auth, AuthError } from "../../src/runtime/auth-client";

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const originalFetch = globalThis.fetch;

describe("auth client helpers", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("auth.register", () => {
    it("sends POST /auth/register with JSON body and returns the user", async () => {
      const user = { id: "1", provider: "email", email: "a@b.com", name: "A", avatar_url: null };
      vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(user));

      const result = await auth.register({ email: "a@b.com", password: "pw", name: "A" });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/auth/register",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ email: "a@b.com", password: "pw", name: "A" }),
        }),
      );
      expect(result).toEqual(user);
    });

    it("throws AuthError on failure", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        jsonResponse({ error: "Email already exists" }, 409),
      );

      const err = await auth.register({ email: "a@b.com", password: "pw" }).catch((e) => e);

      expect(err).toBeInstanceOf(AuthError);
      expect(err.status).toBe(409);
      expect(err.message).toBe("Email already exists");
    });
  });

  describe("auth.login", () => {
    it("sends POST /auth/login and returns the user", async () => {
      const user = { id: "1", provider: "email", email: "a@b.com", name: null, avatar_url: null };
      vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(user));

      const result = await auth.login({ email: "a@b.com", password: "pw" });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/auth/login",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ email: "a@b.com", password: "pw" }),
        }),
      );
      expect(result).toEqual(user);
    });

    it("throws AuthError on invalid credentials", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        jsonResponse({ error: "Invalid credentials" }, 401),
      );

      const err = await auth.login({ email: "a@b.com", password: "wrong" }).catch((e) => e);

      expect(err).toBeInstanceOf(AuthError);
      expect(err.status).toBe(401);
      expect(err.message).toBe("Invalid credentials");
    });
  });

  describe("auth.me", () => {
    it("returns the user when authenticated", async () => {
      const user = { id: "1", provider: "github", email: "a@b.com", name: "A", avatar_url: null };
      vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(user));

      const result = await auth.me();

      expect(globalThis.fetch).toHaveBeenCalledWith("/auth/me");
      expect(result).toEqual(user);
    });

    it("returns null when not authenticated", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(new Response("Unauthorized", { status: 401 }));

      const result = await auth.me();

      expect(result).toBeNull();
    });
  });

  describe("auth.logout", () => {
    it("sends POST /auth/logout", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 204 }));

      await auth.logout();

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/auth/logout",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  describe("AuthError", () => {
    it("extracts message from error field in response data", () => {
      const err = new AuthError(400, { error: "Bad request" });
      expect(err.message).toBe("Bad request");
      expect(err.status).toBe(400);
      expect(err.data).toEqual({ error: "Bad request" });
      expect(err.name).toBe("AuthError");
    });

    it("falls back to generic message when no error field", () => {
      const err = new AuthError(500, null);
      expect(err.message).toBe("Auth request failed (500)");
    });
  });
});
