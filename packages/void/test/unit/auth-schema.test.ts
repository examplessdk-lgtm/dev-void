import { describe, expect, it } from "vitest";

import { CREATE_AUTH_TABLES_SQL, generateUserId } from "../../src/auth/schema";

describe("CREATE_AUTH_TABLES_SQL", () => {
  it("creates auth_users table with IF NOT EXISTS", () => {
    expect(CREATE_AUTH_TABLES_SQL).toContain("CREATE TABLE IF NOT EXISTS auth_users");
  });

  it("includes required columns", () => {
    expect(CREATE_AUTH_TABLES_SQL).toContain("id TEXT PRIMARY KEY");
    expect(CREATE_AUTH_TABLES_SQL).toContain("provider TEXT NOT NULL");
    expect(CREATE_AUTH_TABLES_SQL).toContain("provider_id TEXT NOT NULL");
    expect(CREATE_AUTH_TABLES_SQL).toContain("email TEXT");
    expect(CREATE_AUTH_TABLES_SQL).toContain("password_hash TEXT");
  });

  it("includes unique constraint on provider + provider_id", () => {
    expect(CREATE_AUTH_TABLES_SQL).toContain("UNIQUE(provider, provider_id)");
  });
});

describe("generateUserId", () => {
  it("returns a UUID string", () => {
    const id = generateUserId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
