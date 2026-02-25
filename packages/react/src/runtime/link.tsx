import type { MouseEvent, AnchorHTMLAttributes, ButtonHTMLAttributes } from "react";

import { useContext, type JSX } from "react";

import { RouterContext } from "./context";

type CommonProps = {
  href: string;
  method?: string;
  data?: Record<string, unknown>;
  preserveScroll?: boolean;
  viewTransition?: boolean;
};

export type LinkProps = CommonProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof CommonProps> &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof CommonProps>;

export function Link({
  href,
  method = "GET",
  data,
  preserveScroll = false,
  viewTransition,
  children,
  ...rest
}: LinkProps): JSX.Element {
  const router = useContext(RouterContext);

  function onClick(e: MouseEvent) {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return;
    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin) return;

    e.preventDefault();
    router.visit(href, {
      method,
      data,
      preserveScroll,
      viewTransition,
    });
  }

  const isGet = method.toUpperCase() === "GET";

  if (isGet) {
    return (
      <a href={href} onClick={onClick} {...rest}>
        {children}
      </a>
    );
  }

  return (
    <button type="button" onClick={onClick} {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}>
      {children}
    </button>
  );
}
