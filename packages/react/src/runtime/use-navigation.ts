import { useContext } from 'react';
import type { NavigationState } from 'void/pages-client';
import { NavigationContext } from './context';

export type { NavigationState } from 'void/pages-client';

export function useNavigation(): NavigationState {
  return useContext(NavigationContext);
}
