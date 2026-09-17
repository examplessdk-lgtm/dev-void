import { createContext, ReactNode, useContext } from 'react';
import type { ThemeAssets } from '../types/theme-context.ts';

type ThemeContextProviderProps = Readonly<{
  children: ReactNode;
  value: ThemeAssets;
}>;

const ThemeContext = createContext<ThemeAssets | null>(null);

export function ThemeContextProvider({ children, value }: ThemeContextProviderProps) {
  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useThemeContext() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useThemeContext must be used within ThemeContextProvider');
  }
  return context;
}
