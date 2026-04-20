import { idleNavigationState, type NavigationState } from 'void/pages-client';
import { inject } from 'vue';

export type { NavigationState } from 'void/pages-client';

export function useNavigation(): NavigationState {
  return inject<any>('__void_navigation', null) ?? idleNavigationState();
}
