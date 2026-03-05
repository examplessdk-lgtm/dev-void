import { db } from "void/db";
import { kv } from "void/kv";
import type { Route } from "./+types/smoke";

export async function loader() {
  const users = await db.list("users", { limit: 1 });
  const user = users[0] ?? null;

  await kv.put("smoke", "ok");
  const kvValue = await kv.get<string>("smoke");

  return { d1User: user, kvValue };
}

export default function SmokePage({ loaderData }: Route.ComponentProps) {
  const { d1User, kvValue } = loaderData;

  return (
    <div style={{ padding: "16px" }}>
      <h1>Smoke Test</h1>
      <p>
        D1 user: <span data-testid="d1-user">{d1User?.name ?? "none"}</span>
      </p>
      <p>
        KV value: <span data-testid="kv-value">{kvValue ?? "none"}</span>
      </p>
    </div>
  );
}
