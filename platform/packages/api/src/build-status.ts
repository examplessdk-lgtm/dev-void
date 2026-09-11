import type { Build } from './types.ts';

/** Build statuses that will never change again. */
export const TERMINAL_STATUSES: ReadonlyArray<Build['status']> = [
  'complete',
  'failed',
  'cancelled',
];

export function isTerminalBuildStatus(status: Build['status']): boolean {
  return TERMINAL_STATUSES.includes(status);
}
