import { createContext, type Context } from 'solid-js';

export const SharedContext: Context<any> = createContext<any>(null);
export const ErrorsContext: Context<any> = createContext<any>(null);
export const RouterContext: Context<any> = createContext<any>(null);
