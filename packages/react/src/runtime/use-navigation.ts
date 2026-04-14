import { useContext, useEffect, useRef } from 'react';
import { RouterContext } from './context';

export function useNavigation(onStart?: () => void, onEnd?: () => void): void {
  const router = useContext(RouterContext);
  const startRef = useRef(onStart);
  const endRef = useRef(onEnd);
  startRef.current = onStart;
  endRef.current = onEnd;

  useEffect(() => {
    if (!router) {
      return;
    }
    return router.onNavigation(
      () => startRef.current?.(),
      () => endRef.current?.(),
    );
  }, [router]);
}
