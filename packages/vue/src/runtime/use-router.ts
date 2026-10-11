import { ssrProxy } from 'void/pages-client';
import type { VoidRouter } from 'void/pages-client';
import { inject } from 'vue';

export function useRouter(): VoidRouter {
  return inject<VoidRouter | null>('__void_router', null) ?? ssrProxy;
}
