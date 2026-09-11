import { describe, expect, it } from 'vite-plus/test';
import { TERMINAL_STATUSES, isTerminalBuildStatus } from '../../src/build-status.ts';

describe('isTerminalBuildStatus', () => {
  it('treats complete/failed/cancelled as terminal', () => {
    expect(isTerminalBuildStatus('complete')).toBe(true);
    expect(isTerminalBuildStatus('failed')).toBe(true);
    expect(isTerminalBuildStatus('cancelled')).toBe(true);
  });

  it('treats in-flight statuses as non-terminal', () => {
    expect(isTerminalBuildStatus('queued')).toBe(false);
    expect(isTerminalBuildStatus('starting')).toBe(false);
    expect(isTerminalBuildStatus('building')).toBe(false);
    expect(isTerminalBuildStatus('deploying')).toBe(false);
  });

  it('exposes exactly the three terminal statuses', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(['cancelled', 'complete', 'failed']);
  });
});
