import { describe, expect, it } from "vitest";

import {
  parseSessionCookie,
  buildSetCookieHeader,
  buildClearCookieHeader,
  generateSessionId,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
} from "../../src/auth/session";

describe("parseSessionCookie", () => {
  it("returns null for null/undefined input", () => {
    expect(parseSessionCookie(null)).toBeNull();
    expect(parseSessionCookie(undefined)).toBeNull();
  });

  it("returns null when cookie is not present", () => {
    expect(parseSessionCookie("other=value")).toBeNull();
  });

  it("extracts session ID from cookie header", () => {
    const sid = "abc-123-def";
    expect(parseSessionCookie(`${SESSION_COOKIE_NAME}=${sid}`)).toBe(sid);
  });

  it("extracts session ID from multi-cookie header", () => {
    const sid = "abc-123-def";
    expect(parseSessionCookie(`other=foo; ${SESSION_COOKIE_NAME}=${sid}; third=bar`)).toBe(sid);
  });

  it("returns null for empty cookie value", () => {
    expect(parseSessionCookie(`${SESSION_COOKIE_NAME}=`)).toBeNull();
  });
});

describe("buildSetCookieHeader", () => {
  it("builds cookie with HttpOnly, SameSite, Path, Max-Age", () => {
    const header = buildSetCookieHeader("session-id", false);
    expect(header).toContain(`${SESSION_COOKIE_NAME}=session-id`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
    expect(header).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    expect(header).not.toContain("Secure");
  });

  it("includes Secure flag when secure=true", () => {
    const header = buildSetCookieHeader("session-id", true);
    expect(header).toContain("Secure");
  });
});

describe("buildClearCookieHeader", () => {
  it("builds cookie with Max-Age=0", () => {
    const header = buildClearCookieHeader();
    expect(header).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("HttpOnly");
  });
});

describe("generateSessionId", () => {
  it("returns a UUID string", () => {
    const id = generateSessionId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("returns unique values", () => {
    const a = generateSessionId();
    const b = generateSessionId();
    expect(a).not.toBe(b);
  });
});
