import { useContext } from 'react';
import type { CloudContextVariables } from 'void';
import { SharedContext } from './context';

export function useShared<T = CloudContextVariables['shared']>(): T {
  const shared = useContext(SharedContext);
  if (!shared) {
    throw new Error('useShared() must be used inside a Void page');
  }
  return shared as T;
}
