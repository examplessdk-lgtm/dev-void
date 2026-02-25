import type { CloudContextVariables } from "void";

import { inject } from "vue";

export function useShared<T = CloudContextVariables["shared"]>(): T {
  const shared = inject<T>("__void_shared");
  if (!shared) throw new Error("useShared() must be used inside a Void page");
  return shared;
}
