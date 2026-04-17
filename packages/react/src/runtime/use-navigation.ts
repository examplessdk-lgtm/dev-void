import { useContext, useEffect, useRef } from 'react';
import { NavigationContext, RouterContext } from './context';

export interface NavigationState {
  isPending: boolean;
  location: string;
  pendingLocation: string | null;
  type: string | null;
}

export function useNavigation(): NavigationState;
export function useNavigation(onStart?: () => void, onEnd?: () => void): NavigationState;
export function useNavigation(onStart?: () => void, onEnd?: () => void): NavigationState {
  const router = useContext(RouterContext);
  const navigation = useContext(NavigationContext);
  const startRef = useRef(onStart);
  const endRef = useRef(onEnd);

  useEffect(() => {
    startRef.current = onStart;
  }, [onStart]);

  useEffect(() => {
    endRef.current = onEnd;
  }, [onEnd]);

  useEffect(() => {
    if (!router) {
      return;
    }
    return router.onNavigation(
      () => startRef.current?.(),
      () => endRef.current?.(),
    );
  }, [router]);

  return navigation;
}
