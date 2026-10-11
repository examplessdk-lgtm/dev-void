import { idleNavigationState, type NavigationState } from 'void/pages-client';
import { inject } from 'vue';

export function useNavigation(): NavigationState {
  return inject<NavigationState | null>('__void_navigation', null) ?? idleNavigationState();
}
