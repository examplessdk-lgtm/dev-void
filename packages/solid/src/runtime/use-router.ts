import { useContext } from "solid-js";

import { RouterContext } from "./context";

export function useRouter() {
  const router = useContext(RouterContext);
  if (!router) {
    throw new Error(
      "useRouter() must be used inside a pages component (router not available during SSR)",
    );
  }
  return router as {
    onNavigation(onStart?: () => void, onEnd?: () => void): () => void;
    visit(url: string, options?: Record<string, unknown>): Promise<unknown>;
    reload(): Promise<unknown>;
    post(
      url: string,
      data?: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<unknown>;
    put(
      url: string,
      data?: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<unknown>;
    patch(
      url: string,
      data?: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<unknown>;
    delete(url: string, options?: Record<string, unknown>): Promise<unknown>;
  };
}
