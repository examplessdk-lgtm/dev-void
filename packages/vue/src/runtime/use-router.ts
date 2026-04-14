import { ssrProxy } from 'void/pages-client';
import type { VoidRouter } from 'void/pages-client';
import { inject } from 'vue';

export type { VoidRouter } from 'void/pages-client';

export function useRouter(): VoidRouter {
  return inject<any>('__void_router', null) ?? ssrProxy;
}
