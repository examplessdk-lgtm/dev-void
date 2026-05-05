import { posix } from 'pathe';

export const isWindows: boolean = typeof process !== 'undefined' && process.platform === 'win32';

export function slash(p: string): string {
  return p.replace(/\\/g, '/');
}

export function toSlash(p: string): string {
  return isWindows ? slash(p) : p;
}

export function normalizePath(id: string): string {
  return posix.normalize(toSlash(id));
}
