import { Link } from "void/react";

import type { Props } from "./index.server";

export default function HomePage({ title }: Props) {
  return (
    <div>
      <h1>Welcome — {title}</h1>
      <p>This is the React Pages playground.</p>
      <Link href="/users">Go to Users</Link>
    </div>
  );
}
