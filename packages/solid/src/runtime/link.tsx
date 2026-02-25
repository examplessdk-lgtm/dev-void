import type { JSX } from "solid-js";

import { useContext, splitProps, createMemo } from "solid-js";

import { RouterContext } from "./context";

type CommonProps = {
  href: string;
  method?: string;
  data?: Record<string, unknown>;
  preserveScroll?: boolean;
  viewTransition?: boolean;
  children?: JSX.Element;
};

export type LinkProps = CommonProps &
  Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, keyof CommonProps>;

export function Link(props: LinkProps): JSX.Element {
  const [local, rest] = splitProps(props, [
    "href",
    "method",
    "data",
    "preserveScroll",
    "viewTransition",
    "children",
  ]);
  const router = useContext(RouterContext);

  function onClick(e: MouseEvent) {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return;
    const url = new URL(local.href, window.location.origin);
    if (url.origin !== window.location.origin) return;

    e.preventDefault();
    router?.visit(local.href, {
      method: local.method,
      data: local.data,
      preserveScroll: local.preserveScroll,
      viewTransition: local.viewTransition,
    });
  }

  const isGet = createMemo(() => (local.method || "GET").toUpperCase() === "GET");

  return (
    <>
      {isGet() ? (
        <a href={local.href} onClick={onClick} {...rest}>
          {local.children}
        </a>
      ) : (
        <button type="button" onClick={onClick} {...(rest as any)}>
          {local.children}
        </button>
      )}
    </>
  );
}
