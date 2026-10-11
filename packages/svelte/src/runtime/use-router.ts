import { getContext } from 'svelte';
import { ssrProxy } from 'void/pages-client';
import type { VoidRouter } from 'void/pages-client';

export function useRouter(): VoidRouter {
  return getContext<VoidRouter>('__void_router') ?? ssrProxy;
}
