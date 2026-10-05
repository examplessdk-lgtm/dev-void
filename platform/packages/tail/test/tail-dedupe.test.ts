import { describe, it, expect, vi } from 'vite-plus/test';
import worker from '../src/index.ts';

function traceItem(scriptName: string, url: string): TraceItem {
  return {
    scriptName,
    outcome: 'ok',
    eventTimestamp: 1,
    event: { request: { url, method: 'GET' }, response: { status: 200 } },
    logs: [],
    exceptions: [],
  } as unknown as TraceItem;
}

function run(events: Array<TraceItem>, dispatchName?: string) {
  const writeDataPoint = vi.fn();
  const env = {
    ANALYTICS: { writeDataPoint } as unknown as AnalyticsEngineDataset,
    PLATFORM_DISPATCH_WORKER_NAME: dispatchName,
  };
  return worker.tail(events, env).then(() => writeDataPoint.mock.calls.map((call) => call[0]));
}

describe('tail batch dedupe', () => {
  it('writes only the dispatcher item when the batch comes from the dispatch Worker', async () => {
    const points = await run(
      [
        traceItem('void-dispatch-e2e2', 'https://app.example.com/'),
        traceItem('user-app-dpl_abc', 'https://app.example.com/'),
      ],
      'void-dispatch-e2e2',
    );
    expect(points.map((point) => point.indexes[0])).toEqual(['__platform-dispatch']);
  });

  it('recognizes the default dispatch Worker names', async () => {
    const points = await run([
      traceItem('void-dispatch-staging', 'https://app.example.com/'),
      traceItem('user-app-dpl_abc', 'https://app.example.com/'),
    ]);
    expect(points.map((point) => point.indexes[0])).toEqual(['__platform-dispatch-staging']);
  });

  it('writes a user item delivered by its own tail consumer', async () => {
    const points = await run(
      [traceItem('user-app-dpl_abc', 'https://app.example.com/')],
      'void-dispatch-e2e2',
    );
    expect(points.map((point) => point.indexes[0])).toEqual(['user-app']);
  });

  it('writes every user item when the batch has no dispatcher item', async () => {
    const points = await run(
      [
        traceItem('user-app-dpl_abc', 'https://app.example.com/a'),
        traceItem('user-other-dpl_def', 'https://other.example.com/b'),
      ],
      'void-dispatch-e2e2',
    );
    expect(points.map((point) => point.indexes[0])).toEqual(['user-app', 'user-other']);
  });
});
