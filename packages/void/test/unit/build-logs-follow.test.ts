import { describe, expect, it } from 'vite-plus/test';
import { followBuildLogs } from '../../src/cli/build-cmd.ts';
import type { BuildLogsResponse } from '../../src/cli/client.ts';

function page(partial: Partial<BuildLogsResponse>): BuildLogsResponse {
  return { lines: [], lastSeq: 0, status: 'building', terminal: false, external: null, ...partial };
}

describe('followBuildLogs', () => {
  it('polls from the cursor, writes new lines in order, and stops when terminal', async () => {
    const pages: Array<BuildLogsResponse> = [
      page({
        lines: [{ seq: 2, line: 'b', stream: 'stdout', ts: 2 }],
        lastSeq: 2,
        status: 'building',
        terminal: false,
      }),
      page({
        lines: [{ seq: 3, line: 'c', stream: 'stderr', ts: 3 }],
        lastSeq: 3,
        status: 'complete',
        terminal: true,
      }),
    ];
    const sinceCalls: Array<number> = [];
    const written: Array<string> = [];
    let i = 0;

    const result = await followBuildLogs({
      fetchPage: (since) => {
        sinceCalls.push(since);
        return Promise.resolve(pages[i++]!);
      },
      write: (line) => written.push(line),
      sleep: () => Promise.resolve(),
      since: 1,
      status: 'building',
      pollMs: 0,
    });

    expect(sinceCalls).toEqual([1, 2]); // advances cursor to each page's lastSeq
    expect(written).toEqual(['b', 'c']);
    expect(result).toEqual({ status: 'complete', terminal: true });
  });

  it('survives a transient fetch failure: onRetry once, no cursor advance, then continues', async () => {
    const sinceCalls: Array<number> = [];
    const written: Array<string> = [];
    const retries: Array<unknown> = [];
    let call = 0;

    const result = await followBuildLogs({
      fetchPage: (since) => {
        sinceCalls.push(since);
        call += 1;
        if (call === 1) {
          // Transient blip on the first poll (e.g. a 502/timeout).
          return Promise.reject(new Error('boom'));
        }
        return Promise.resolve(
          page({
            lines: [{ seq: 3, line: 'c', stream: 'stdout', ts: 3 }],
            lastSeq: 3,
            status: 'complete',
            terminal: true,
          }),
        );
      },
      write: (line) => written.push(line),
      sleep: () => Promise.resolve(),
      since: 2,
      status: 'building',
      pollMs: 0,
      isFatal: () => false,
      onRetry: (err) => retries.push(err),
    });

    // The failed attempt did NOT advance the cursor: the retry re-requests since=2.
    expect(sinceCalls).toEqual([2, 2]);
    expect(retries).toHaveLength(1); // onRetry called exactly once
    expect((retries[0] as Error).message).toBe('boom');
    // Nothing written on the failed attempt; terminal page's lines written after.
    expect(written).toEqual(['c']);
    expect(result).toEqual({ status: 'complete', terminal: true });
  });

  it('rethrows a fatal fetch failure (isFatal → true)', async () => {
    await expect(
      followBuildLogs({
        fetchPage: () => Promise.reject(new Error('unauthorized')),
        write: () => {},
        sleep: () => Promise.resolve(),
        since: 1,
        status: 'building',
        pollMs: 0,
        isFatal: () => true,
      }),
    ).rejects.toThrow('unauthorized');
  });
});
