import { db } from "void/db";
import { kv } from "void/kv";
import { users } from "@schema";

interface SmokeProps {
  d1User: string;
  kvValue: string;
}

export async function getServerSideProps() {
  const rows = await db.select().from(users).limit(1);
  const user = rows[0] ?? null;

  await kv.put("smoke", "ok");
  const kvValue = await kv.get<string>("smoke");

  return {
    props: {
      d1User: user?.name ?? "none",
      kvValue: kvValue ?? "none",
    },
  };
}

export default function SmokePage({ d1User, kvValue }: SmokeProps) {
  return (
    <div style={{ padding: "16px" }}>
      <h1>Smoke Test</h1>
      <p>
        D1 user: <span data-testid="d1-user">{d1User}</span>
      </p>
      <p>
        KV value: <span data-testid="kv-value">{kvValue}</span>
      </p>
    </div>
  );
}
