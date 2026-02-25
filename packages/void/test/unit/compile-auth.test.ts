import { describe, expect, it } from "vitest";

import type { ScanResult } from "../../src/router/scan";

import { compileRouteTable, type AuthCompileOptions } from "../../src/router/compile";

const emptyScan: ScanResult = {
  routes: [],
  middleware: [],
  jobs: [],
  queues: [],
  pages: { pages: [], layouts: [] },
};

const baseOptions = {
  honoPath: "/resolved/hono/index.mjs",
  responsePath: "/resolved/void/runtime/response.mjs",
  reactRefresh: false,
};

const emailAuth: AuthCompileOptions = {
  providers: ["email"],
  sessionPath: "/resolved/auth/session.mjs",
  passwordPath: "/resolved/auth/password.mjs",
  schemaPath: "/resolved/auth/schema.mjs",
  githubProviderPath: null,
  googleProviderPath: null,
  authRuntimePath: "/resolved/void/runtime/auth.mjs",
};

const githubAuth: AuthCompileOptions = {
  providers: ["github"],
  sessionPath: "/resolved/auth/session.mjs",
  passwordPath: null,
  schemaPath: "/resolved/auth/schema.mjs",
  githubProviderPath: "/resolved/oauth/github.mjs",
  googleProviderPath: null,
  authRuntimePath: "/resolved/void/runtime/auth.mjs",
};

const allAuth: AuthCompileOptions = {
  providers: ["github", "google", "email"],
  sessionPath: "/resolved/auth/session.mjs",
  passwordPath: "/resolved/auth/password.mjs",
  schemaPath: "/resolved/auth/schema.mjs",
  githubProviderPath: "/resolved/oauth/github.mjs",
  googleProviderPath: "/resolved/oauth/google.mjs",
  authRuntimePath: "/resolved/void/runtime/auth.mjs",
};

describe("compileRouteTable with auth", () => {
  it("generates no auth code when auth is null", () => {
    const code = compileRouteTable(emptyScan, "/routes", "/middleware", "/crons", "/queues", null, {
      ...baseOptions,
      auth: null,
    });
    expect(code).not.toContain("parseSessionCookie");
    expect(code).not.toContain("CREATE_AUTH_TABLES_SQL");
    expect(code).not.toContain("/auth/me");
    expect(code).not.toContain("/auth/logout");
  });

  it("generates session imports and middleware when auth is email-only", () => {
    const code = compileRouteTable(emptyScan, "/routes", "/middleware", "/crons", "/queues", null, {
      ...baseOptions,
      auth: emailAuth,
    });
    // Imports
    expect(code).toContain('from "/resolved/auth/session.mjs"');
    expect(code).toContain("parseSessionCookie");
    expect(code).toContain("buildSetCookieHeader");
    expect(code).toContain("buildClearCookieHeader");
    expect(code).toContain("generateSessionId");
    expect(code).toContain("SESSION_TTL_SECONDS");
    expect(code).toContain('from "/resolved/auth/schema.mjs"');
    expect(code).toContain("CREATE_AUTH_TABLES_SQL");
    expect(code).toContain("generateUserId");
    expect(code).toContain('from "/resolved/auth/password.mjs"');
    expect(code).toContain("hashPassword");
    expect(code).toContain("verifyPassword");
    // No OAuth imports
    expect(code).not.toContain("githubAuth");
    expect(code).not.toContain("googleAuth");
  });

  it("generates email register and login routes", () => {
    const code = compileRouteTable(emptyScan, "/routes", "/middleware", "/crons", "/queues", null, {
      ...baseOptions,
      auth: emailAuth,
    });
    expect(code).toContain('app.post("/auth/register"');
    expect(code).toContain('app.post("/auth/login"');
    expect(code).not.toContain('app.get("/auth/login/github"');
    expect(code).not.toContain('app.get("/auth/login/google"');
  });

  it("generates GitHub OAuth route but no email routes for github-only", () => {
    const code = compileRouteTable(emptyScan, "/routes", "/middleware", "/crons", "/queues", null, {
      ...baseOptions,
      auth: githubAuth,
    });
    expect(code).toContain('app.get("/auth/login/github"');
    expect(code).toContain('from "/resolved/oauth/github.mjs"');
    expect(code).toContain("githubAuth");
    expect(code).not.toContain('app.post("/auth/register"');
    expect(code).not.toContain('app.post("/auth/login"');
    expect(code).not.toContain("hashPassword");
  });

  it("generates all auth routes for all providers", () => {
    const code = compileRouteTable(emptyScan, "/routes", "/middleware", "/crons", "/queues", null, {
      ...baseOptions,
      auth: allAuth,
    });
    expect(code).toContain('app.post("/auth/register"');
    expect(code).toContain('app.post("/auth/login"');
    expect(code).toContain('app.get("/auth/login/github"');
    expect(code).toContain('app.get("/auth/login/google"');
    expect(code).toContain('from "/resolved/oauth/github.mjs"');
    expect(code).toContain('from "/resolved/oauth/google.mjs"');
  });

  it("always generates /auth/me and /auth/logout when auth enabled", () => {
    for (const auth of [emailAuth, githubAuth, allAuth]) {
      const code = compileRouteTable(
        emptyScan,
        "/routes",
        "/middleware",
        "/crons",
        "/queues",
        null,
        {
          ...baseOptions,
          auth,
        },
      );
      expect(code).toContain('app.get("/auth/me"');
      expect(code).toContain('app.post("/auth/logout"');
    }
  });

  it("generates auth table creation middleware", () => {
    const code = compileRouteTable(emptyScan, "/routes", "/middleware", "/crons", "/queues", null, {
      ...baseOptions,
      auth: emailAuth,
    });
    expect(code).toContain("let authReady = false;");
    expect(code).toContain("c.env.DB.prepare(CREATE_AUTH_TABLES_SQL).run()");
    expect(code).toContain("authReady = true;");
  });

  it("generates session middleware that reads from AUTH_KV", () => {
    const code = compileRouteTable(emptyScan, "/routes", "/middleware", "/crons", "/queues", null, {
      ...baseOptions,
      auth: emailAuth,
    });
    expect(code).toContain('c.env.AUTH_KV.get("session:" + sid');
    expect(code).toContain('c.set("user"');
  });

  it("places auth middleware before user middleware", () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [{ order: 1, filePath: "01.logger.ts" }],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [] },
    };
    const code = compileRouteTable(scan, "/routes", "/middleware", "/crons", "/queues", null, {
      ...baseOptions,
      auth: emailAuth,
    });
    const authReadyIdx = code.indexOf("let authReady");
    const userMiddlewareIdx = code.indexOf("app.use(middleware0)");
    expect(authReadyIdx).toBeLessThan(userMiddlewareIdx);
  });

  it("places auth routes after user middleware but before user routes", () => {
    const scan: ScanResult = {
      routes: [
        {
          pattern: "/api/hello",
          methods: ["GET"],
          params: [],
          catchAll: false,
          env: null,
          filePath: "api/hello.ts",
        },
      ],
      middleware: [{ order: 1, filePath: "01.logger.ts" }],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [] },
    };
    const code = compileRouteTable(scan, "/routes", "/middleware", "/crons", "/queues", null, {
      ...baseOptions,
      auth: emailAuth,
    });
    const userMiddlewareIdx = code.indexOf("app.use(middleware0)");
    const authRegisterIdx = code.indexOf('app.post("/auth/register"');
    const userRouteIdx = code.indexOf('app.get("/api/hello"');
    expect(userMiddlewareIdx).toBeLessThan(authRegisterIdx);
    expect(authRegisterIdx).toBeLessThan(userRouteIdx);
  });

  it("uses GITHUB_OAUTH_ID/SECRET env vars for GitHub OAuth", () => {
    const code = compileRouteTable(emptyScan, "/routes", "/middleware", "/crons", "/queues", null, {
      ...baseOptions,
      auth: githubAuth,
    });
    expect(code).toContain("c.env.GITHUB_OAUTH_ID");
    expect(code).toContain("c.env.GITHUB_OAUTH_SECRET");
    // Old env var names should not appear
    expect(code).not.toContain("GITHUB_ID");
    expect(code).not.toContain("GITHUB_SECRET");
  });

  it("uses GOOGLE_OAUTH_ID/SECRET env vars for Google OAuth", () => {
    const googleAuth: AuthCompileOptions = {
      providers: ["google"],
      sessionPath: "/resolved/auth/session.mjs",
      passwordPath: null,
      schemaPath: "/resolved/auth/schema.mjs",
      githubProviderPath: null,
      googleProviderPath: "/resolved/oauth/google.mjs",
      authRuntimePath: "/resolved/void/runtime/auth.mjs",
    };
    const code = compileRouteTable(emptyScan, "/routes", "/middleware", "/crons", "/queues", null, {
      ...baseOptions,
      auth: googleAuth,
    });
    expect(code).toContain("c.env.GOOGLE_OAUTH_ID");
    expect(code).toContain("c.env.GOOGLE_OAUTH_SECRET");
    // Old env var names should not appear
    expect(code).not.toContain("GOOGLE_ID");
    expect(code).not.toContain("GOOGLE_SECRET");
  });

  it("passes OAuth credentials explicitly to provider middleware", () => {
    const code = compileRouteTable(emptyScan, "/routes", "/middleware", "/crons", "/queues", null, {
      ...baseOptions,
      auth: allAuth,
    });
    // GitHub: credentials passed as config, not relying on env defaults
    expect(code).toContain("client_id: c.env.GITHUB_OAUTH_ID");
    expect(code).toContain("client_secret: c.env.GITHUB_OAUTH_SECRET");
    // Google: credentials passed as config
    expect(code).toContain("client_id: c.env.GOOGLE_OAUTH_ID");
    expect(code).toContain("client_secret: c.env.GOOGLE_OAUTH_SECRET");
  });
});
