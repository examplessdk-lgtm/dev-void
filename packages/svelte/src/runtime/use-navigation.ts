import { getContext, onDestroy } from 'svelte';

export function useNavigation(onStart?: () => void, onEnd?: () => void): void {
  const router = getContext<any>('__void_router');
  if (!router) {
    return;
  }
  const unsub = router.onNavigation(onStart, onEnd);
  onDestroy(unsub);
}
