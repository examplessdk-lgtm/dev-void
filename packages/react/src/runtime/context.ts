import { createContext, type Context } from 'react';
import { idleNavigationState } from 'void/pages-client';

export const SharedContext: Context<any> = createContext<any>(null);
export const ErrorsContext: Context<any> = createContext<any>(null);
export const RouterContext: Context<any> = createContext<any>(null);
export const NavigationContext: Context<any> = createContext<any>(idleNavigationState());
