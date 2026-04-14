import { useContext } from 'solid-js';
import { ssrProxy } from 'void/pages-client';
import type { VoidRouter } from 'void/pages-client';
import { RouterContext } from './context';

export type { VoidRouter } from 'void/pages-client';

export function useRouter(): VoidRouter {
  return useContext(RouterContext) ?? ssrProxy;
}
