import { Link } from "void/solid";

import type { Props } from "./index.server";

export default function HomePage(props: Props) {
  return (
    <div>
      <h1>Welcome — {props.title}</h1>
      <p>This is the Solid Pages playground.</p>
      <Link href="/users">Go to Users</Link>
    </div>
  );
}
