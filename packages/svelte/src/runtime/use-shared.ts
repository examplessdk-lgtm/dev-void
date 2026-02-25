import type { CloudContextVariables } from "void";

import { getContext } from "svelte";

export function useShared<T = CloudContextVariables["shared"]>(): T {
  const ctx = getContext<{ value: T }>("__void_shared");
  if (!ctx) throw new Error("useShared() must be used inside a Void page");
  return ctx.value;
}
