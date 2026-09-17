import { describe, expect, it, vi } from 'vite-plus/test';
import {
  assertSandboxContainerCreationAllowed,
  readSandboxDrainState,
  SANDBOX_DRAIN_STATE_KEY,
} from '../../src/sandbox-drain.ts';

function memoryRouting(initial?: string) {
  let value = initial ?? null;
  return {
    get: vi.fn(async (key: string) => {
      expect(key).toBe(SANDBOX_DRAIN_STATE_KEY);
      return value;
    }),
    put: vi.fn(async (key: string, next: string) => {
      expect(key).toBe(SANDBOX_DRAIN_STATE_KEY);
      value = next;
    }),
  } as unknown as Pick<KVNamespace, 'get' | 'put'>;
}

describe('Sandbox drain state', () => {
  it('keeps creation closed after a valid completion mirror', async () => {
    const routing = memoryRouting(
      JSON.stringify({
        version: 1,
        generation: 'generation-1',
        state: 'complete',
        startedAt: '2026-09-16T00:00:00.000Z',
        updatedAt: '2026-09-16T00:01:00.000Z',
        completedAt: '2026-09-16T00:01:00.000Z',
      }),
    );
    expect((await readSandboxDrainState(routing))?.state).toBe('complete');
    await expect(assertSandboxContainerCreationAllowed(routing)).rejects.toThrow(
      /disabled by the platform drain gate/i,
    );
  });

  it('rejects an invalid lifecycle document instead of reopening creation', async () => {
    const routing = memoryRouting('{"version":1,"state":"complete"}');
    await expect(readSandboxDrainState(routing)).rejects.toThrow(/invalid state document/i);
    await expect(assertSandboxContainerCreationAllowed(routing)).rejects.toThrow(
      /invalid state document/i,
    );
  });
});
