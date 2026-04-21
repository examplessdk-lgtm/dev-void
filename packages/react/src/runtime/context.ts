import { createContext, type Context } from 'react';
import { idleNavigationState, type NavigationState, type VoidRouter } from 'void/pages-client';

export const SharedContext: Context<Record<string, unknown> | null> = createContext<
  Record<string, unknown> | null
>(null);
export const ErrorsContext: Context<Record<string, string> | null> = createContext<
  Record<string, string> | null
>(null);
export const RouterContext: Context<VoidRouter | null> = createContext<VoidRouter | null>(null);
export const NavigationContext: Context<NavigationState> = createContext<NavigationState>(
  idleNavigationState(),
);
