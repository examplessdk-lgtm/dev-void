import { inject, onUnmounted } from 'vue';

export function useNavigation(onStart?: () => void, onEnd?: () => void): void {
  const router = inject<any>('__void_router', null);
  if (!router) {
    return;
  }
  const unsub = router.onNavigation(onStart, onEnd);
  onUnmounted(unsub);
}
