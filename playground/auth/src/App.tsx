import type { AuthUser } from "void/client";

import { useState, useEffect } from "react";
import { auth, AuthError } from "void/client";

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [response, setResponse] = useState<string>("");

  // Email login form
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");

  // Email register form
  const [regEmail, setRegEmail] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regName, setRegName] = useState("");

  const fetchUser = () => {
    setLoading(true);
    auth
      .me()
      .then((u) => {
        setUser(u);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  useEffect(fetchUser, []);

  const showResponse = (label: string, data: unknown) => {
    setResponse(`${label}:\n${JSON.stringify(data, null, 2)}`);
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const u = await auth.register({
        email: regEmail,
        password: regPassword,
        name: regName || undefined,
      });
      showResponse("POST /auth/register (200)", u);
      setUser(u);
    } catch (err) {
      if (err instanceof AuthError) {
        showResponse(`POST /auth/register (${err.status})`, err.data);
      }
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const u = await auth.login({ email: loginEmail, password: loginPassword });
      showResponse("POST /auth/login (200)", u);
      setUser(u);
    } catch (err) {
      if (err instanceof AuthError) {
        showResponse(`POST /auth/login (${err.status})`, err.data);
      }
    }
  };

  const handleLogout = async () => {
    await auth.logout();
    setUser(null);
    setResponse("Logged out");
  };

  const handleProfile = async () => {
    const res = await fetch("/api/profile");
    const data = await res.json();
    showResponse(`GET /api/profile (${res.status})`, data);
  };

  if (loading) return <p>Loading...</p>;

  return (
    <div style={{ fontFamily: "system-ui", maxWidth: 600, margin: "0 auto", padding: 20 }}>
      <h1>Auth Playground</h1>

      <section>
        <h2>Status</h2>
        {user ? (
          <div>
            <p>
              Logged in as <strong>{user.name || user.email || user.id}</strong> ({user.provider})
            </p>
            <pre>{JSON.stringify(user, null, 2)}</pre>
            <button onClick={handleLogout}>Logout</button>
          </div>
        ) : (
          <p>Not logged in</p>
        )}
      </section>

      <hr />

      <section>
        <h2>Email Register</h2>
        <form onSubmit={handleRegister}>
          <div>
            <input
              type="email"
              placeholder="Email"
              value={regEmail}
              onChange={(e) => setRegEmail(e.target.value)}
              required
            />
          </div>
          <div>
            <input
              type="password"
              placeholder="Password"
              value={regPassword}
              onChange={(e) => setRegPassword(e.target.value)}
              required
            />
          </div>
          <div>
            <input
              type="text"
              placeholder="Name (optional)"
              value={regName}
              onChange={(e) => setRegName(e.target.value)}
            />
          </div>
          <button type="submit">Register</button>
        </form>
      </section>

      <section>
        <h2>Email Login</h2>
        <form onSubmit={handleLogin}>
          <div>
            <input
              type="email"
              placeholder="Email"
              value={loginEmail}
              onChange={(e) => setLoginEmail(e.target.value)}
              required
            />
          </div>
          <div>
            <input
              type="password"
              placeholder="Password"
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              required
            />
          </div>
          <button type="submit">Login</button>
        </form>
      </section>

      <hr />

      <section>
        <h2>OAuth</h2>
        <a href="/auth/login/github">
          <button type="button">Login with GitHub</button>
        </a>{" "}
        <a href="/auth/login/google">
          <button type="button">Login with Google</button>
        </a>
      </section>

      <hr />

      <section>
        <h2>Protected Route</h2>
        <button onClick={handleProfile}>GET /api/profile</button>
        <p>
          Tests <code>requireAuth()</code> — returns 401 if not logged in.
        </p>
      </section>

      {response && (
        <section>
          <h2>Response</h2>
          <pre style={{ background: "#f4f4f4", padding: 12, overflow: "auto" }}>{response}</pre>
        </section>
      )}
    </div>
  );
}
