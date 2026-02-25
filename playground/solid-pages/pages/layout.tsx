import type { JSX } from "solid-js";

import { Link, useShared } from "void/solid";

export default function Layout(props: { children: JSX.Element }) {
  const shared = useShared();
  return (
    <div>
      <nav>
        <Link href="/">Home</Link> | <Link href="/users">Users</Link> |{" "}
        <Link href="/blog">Blog</Link> | <Link href="/deferred">Deferred</Link> |{" "}
        <span>{shared.appName}</span>
      </nav>
      <hr />
      {props.children}
    </div>
  );
}
