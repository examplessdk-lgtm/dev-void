import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "../../src/auth/password";

describe("hashPassword", () => {
  it("returns salt:hash format", async () => {
    const result = await hashPassword("test-password");
    const parts = result.split(":");
    expect(parts).toHaveLength(2);
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
  });

  it("produces different hashes for different calls (random salt)", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
  });
});

describe("verifyPassword", () => {
  it("returns true for correct password", async () => {
    const stored = await hashPassword("correct-password");
    const result = await verifyPassword("correct-password", stored);
    expect(result).toBe(true);
  });

  it("returns false for wrong password", async () => {
    const stored = await hashPassword("correct-password");
    const result = await verifyPassword("wrong-password", stored);
    expect(result).toBe(false);
  });

  it("returns false for malformed stored value", async () => {
    const result = await verifyPassword("any", "not-valid");
    expect(result).toBe(false);
  });
});
