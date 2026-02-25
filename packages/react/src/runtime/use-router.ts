import { useContext } from "react";

import { RouterContext } from "./context";

export function useRouter() {
  const router = useContext(RouterContext);
  if (!router) {
    throw new Error("useRouter() must be called inside a Pages component");
  }
  return router as {
    onNavigation(onStart?: () => void, onEnd?: () => void): () => void;
    visit(
      url: string,
      options?: {
        method?: string;
        data?: unknown;
        preserveScroll?: boolean;
        preserveState?: boolean;
        viewTransition?: boolean;
      },
    ): Promise<unknown>;
    reload(): Promise<unknown>;
    post(url: string, data?: unknown, options?: Record<string, unknown>): Promise<unknown>;
    put(url: string, data?: unknown, options?: Record<string, unknown>): Promise<unknown>;
    patch(url: string, data?: unknown, options?: Record<string, unknown>): Promise<unknown>;
    delete(url: string, options?: Record<string, unknown>): Promise<unknown>;
  };
}
