import { useContext, onCleanup } from 'solid-js';
import { RouterContext } from './context';

export function useNavigation(onStart?: () => void, onEnd?: () => void): void {
  const router = useContext(RouterContext);
  if (!router) {
    return;
  }
  const unsub = router.onNavigation(onStart, onEnd);
  onCleanup(unsub);
}
