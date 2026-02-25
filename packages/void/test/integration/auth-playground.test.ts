import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const DEV_PORT = 5193;
const BASE = `http://127.0.0.1:${DEV_PORT}`;

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.status > 0) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for dev server at ${url}`);
}

describe("playground/auth email flow", () => {
  let child: ReturnType<typeof spawn>;
  let stderr = "";

  beforeAll(async () => {
    child = spawn(
      "pnpm",
      [
        "--dir",
        "playground/auth",
        "exec",
        "vite",
        "--host",
        "127.0.0.1",
        "--port",
        String(DEV_PORT),
        "--strictPort",
      ],
      {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          VOID_INSPECTOR_PORT: "false",
        },
      },
    );

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });

    await waitForServer(BASE, 20_000);
  }, 30_000);

  afterAll(async () => {
    if (child) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await Promise.race([
          once(child, "exit"),
          new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }
    }
    if (stderr.includes("error when starting dev server")) {
      throw new Error(stderr);
    }
  });

  it("register, login, session, logout lifecycle", async () => {
    // 1. GET /auth/me without session → 401
    const meUnauth = await fetch(`${BASE}/auth/me`);
    expect(meUnauth.status).toBe(401);

    // 2. POST /auth/register → 201 + session cookie
    const email = `test-${Date.now()}@example.com`;
    const password = "s3cureP@ss!";
    const name = "Test User";

    const registerRes = await fetch(`${BASE}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name }),
    });
    expect(registerRes.status).toBe(201);

    const registerBody: any = await registerRes.json();
    expect(registerBody.id).toBeDefined();
    expect(registerBody.email).toBe(email);
    expect(registerBody.name).toBe(name);

    const setCookie = registerRes.headers.get("set-cookie") ?? "";
    const sessionMatch = setCookie.match(/__void_session=([^;]+)/);
    expect(sessionMatch).not.toBeNull();
    const sessionCookie = `__void_session=${sessionMatch![1]}`;

    // 3. GET /auth/me with cookie → 200
    const meAuth = await fetch(`${BASE}/auth/me`, {
      headers: { Cookie: sessionCookie },
    });
    expect(meAuth.status).toBe(200);
    const meBody: any = await meAuth.json();
    expect(meBody.provider).toBe("email");
    expect(meBody.id).toBe(registerBody.id);
    expect(meBody.email).toBe(email);

    // 4. GET /api/profile with cookie → 200 (requireAuth)
    const profileAuth = await fetch(`${BASE}/api/profile`, {
      headers: { Cookie: sessionCookie },
    });
    expect(profileAuth.status).toBe(200);
    const profileBody: any = await profileAuth.json();
    expect(profileBody.user).toBeDefined();
    expect(profileBody.user.email).toBe(email);

    // 5. POST /auth/register same email → 409
    const dupeRes = await fetch(`${BASE}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name }),
    });
    expect(dupeRes.status).toBe(409);

    // 6. POST /auth/logout → 302, clears cookie
    const logoutRes = await fetch(`${BASE}/auth/logout`, {
      method: "POST",
      headers: { Cookie: sessionCookie },
      redirect: "manual",
    });
    expect(logoutRes.status).toBe(302);
    const logoutSetCookie = logoutRes.headers.get("set-cookie") ?? "";
    expect(logoutSetCookie).toContain("__void_session=");

    // 7. GET /auth/me with old cookie → 401 (session invalidated)
    const meAfterLogout = await fetch(`${BASE}/auth/me`, {
      headers: { Cookie: sessionCookie },
    });
    expect(meAfterLogout.status).toBe(401);

    // 8. GET /api/profile without cookie → 401
    const profileUnauth = await fetch(`${BASE}/api/profile`);
    expect(profileUnauth.status).toBe(401);

    // 9. POST /auth/login with credentials → 200 + new cookie
    const loginRes = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    expect(loginRes.status).toBe(200);

    const loginSetCookie = loginRes.headers.get("set-cookie") ?? "";
    const loginSessionMatch = loginSetCookie.match(/__void_session=([^;]+)/);
    expect(loginSessionMatch).not.toBeNull();
    const newSessionCookie = `__void_session=${loginSessionMatch![1]}`;

    // 10. GET /auth/me with new cookie → 200
    const meAfterLogin = await fetch(`${BASE}/auth/me`, {
      headers: { Cookie: newSessionCookie },
    });
    expect(meAfterLogin.status).toBe(200);
    const meLoginBody: any = await meAfterLogin.json();
    expect(meLoginBody.email).toBe(email);
  });
}, 60_000);
