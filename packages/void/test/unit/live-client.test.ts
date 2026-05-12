import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { connectLiveStream } from '../../src/runtime/live-client.ts';

class MockEventSource {
  static instances: Array<MockEventSource> = [];

  listeners = new Map<string, Set<(event: Event) => void>>();
  closed = false;

  constructor(
    readonly url: string,
    readonly options?: { withCredentials?: boolean },
  ) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  close(): void {
    this.closed = true;
  }
}

const originalLocation = (globalThis as { location?: unknown }).location;

describe('connectLiveStream', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal('location', { href: 'https://void.test/page' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    (globalThis as { location?: unknown }).location = originalLocation;
  });

  it('opens one EventSource and sends subscribe after open', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        accepted: true,
        connectionId: 'connection',
        results: [{ ok: true, kind: 'subscribe', id: 'post-card', topic: 'post:12' }],
      }),
    );
    const live = connectLiveStream('/live', {
      eventSource: MockEventSource,
      fetch: fetchMock as unknown as typeof fetch,
      withCredentials: true,
    });

    const pending = live.subscribe({ id: 'post-card', topic: 'post:12' });
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    const source = MockEventSource.instances[0]!;
    expect(source.url).toContain('/live?connectionId=');
    expect(source.options?.withCredentials).toBe(true);

    source.emit('open', new Event('open'));
    await pending;

    expect(fetchMock).toHaveBeenCalledWith('/live', {
      method: 'POST',
      headers: expect.any(Headers),
      credentials: 'include',
      body: expect.stringContaining('"topic":"post:12"'),
    });
  });

  it('rejects a subscribe waiting for the initial open when closed', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        accepted: true,
        connectionId: 'connection',
        results: [{ ok: true, kind: 'subscribe', id: 'post-card', topic: 'post:12' }],
      }),
    );
    const live = connectLiveStream('/live', {
      eventSource: MockEventSource,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const pending = live.subscribe({ id: 'post-card', topic: 'post:12' });
    await Promise.resolve();
    const source = MockEventSource.instances[0]!;

    live.close();

    await expect(pending).rejects.toThrow('live: stream is closed.');
    expect(source.closed).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('routes message envelopes by subscription id and unsubscribes individually', async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      return Response.json({
        accepted: true,
        connectionId: body.connectionId,
        results: body.operations.map((op: { kind: string; id: string; topic?: string }) => ({
          ok: true,
          kind: op.kind,
          id: op.id,
          topic: op.topic,
        })),
      });
    });
    const handler = vi.fn();
    const live = connectLiveStream('/live', {
      eventSource: MockEventSource,
      fetch: fetchMock as unknown as typeof fetch,
    });
    const unsubscribe = live.subscribe({ id: 'comments', topic: 'comment:2323', onEvent: handler });
    await Promise.resolve();
    const source = MockEventSource.instances[0]!;
    source.emit('open', new Event('open'));
    await unsubscribe;

    source.emit('message', {
      data: JSON.stringify({
        subscriptionId: 'comments',
        topic: 'comment:2323',
        data: { ok: true },
      }),
    } as MessageEvent);
    expect(handler).toHaveBeenCalledWith({
      subscriptionId: 'comments',
      topic: 'comment:2323',
      data: { ok: true },
    });

    await (
      await unsubscribe
    )();
    expect(fetchMock).toHaveBeenLastCalledWith('/live', {
      method: 'POST',
      headers: expect.any(Headers),
      credentials: 'same-origin',
      body: expect.stringContaining('"kind":"unsubscribe"'),
    });
  });

  it('routes events that arrive before the subscribe control ack resolves', async () => {
    const handler = vi.fn();
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      MockEventSource.instances[0]!.emit('message', {
        data: JSON.stringify({
          subscriptionId: 'comments',
          topic: 'comment:2323',
          data: { early: true },
        }),
      } as MessageEvent);
      return Response.json({
        accepted: true,
        connectionId: body.connectionId,
        results: [{ ok: true, kind: 'subscribe', id: 'comments', topic: 'comment:2323' }],
      });
    });
    const live = connectLiveStream('/live', {
      eventSource: MockEventSource,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const unsubscribe = live.subscribe({ id: 'comments', topic: 'comment:2323', onEvent: handler });
    await Promise.resolve();
    MockEventSource.instances[0]!.emit('open', new Event('open'));
    await unsubscribe;

    expect(handler).toHaveBeenCalledWith({
      subscriptionId: 'comments',
      topic: 'comment:2323',
      data: { early: true },
    });
  });

  it('routes replacement events to the replacement handler before the control ack resolves', async () => {
    const oldHandler = vi.fn();
    const newHandler = vi.fn();
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      if (body.operations[0]?.topic === 'post:13') {
        MockEventSource.instances[0]!.emit('message', {
          data: JSON.stringify({
            subscriptionId: 'card',
            topic: 'post:13',
            data: { early: true },
          }),
        } as MessageEvent);
      }
      return Response.json({
        accepted: true,
        connectionId: body.connectionId,
        results: body.operations.map((op: { kind: string; id: string; topic?: string }) => ({
          ok: true,
          kind: op.kind,
          id: op.id,
          topic: op.topic,
        })),
      });
    });
    const live = connectLiveStream('/live', {
      eventSource: MockEventSource,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const first = live.subscribe({ id: 'card', topic: 'post:12', onEvent: oldHandler });
    await Promise.resolve();
    MockEventSource.instances[0]!.emit('open', new Event('open'));
    await first;

    const second = live.subscribe({ id: 'card', topic: 'post:13', onEvent: newHandler });
    await second;

    expect(oldHandler).not.toHaveBeenCalled();
    expect(newHandler).toHaveBeenCalledWith({
      subscriptionId: 'card',
      topic: 'post:13',
      data: { early: true },
    });
  });

  it('keeps per-operation subscribe failures isolated in one control batch', async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      return Response.json({
        accepted: true,
        connectionId: body.connectionId,
        results: [
          { ok: true, kind: 'subscribe', id: 'post-card', topic: 'post:12' },
          {
            ok: false,
            kind: 'subscribe',
            id: 'private-card',
            error: { code: 'FORBIDDEN', message: 'Forbidden' },
          },
        ],
      });
    });
    const postHandler = vi.fn();
    const privateHandler = vi.fn();
    const live = connectLiveStream('/live', {
      eventSource: MockEventSource,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const post = live.subscribe({ id: 'post-card', topic: 'post:12', onEvent: postHandler });
    const privatePost = live.subscribe({
      id: 'private-card',
      topic: 'post:private',
      onEvent: privateHandler,
    });
    await Promise.resolve();
    MockEventSource.instances[0]!.emit('open', new Event('open'));

    await expect(post).resolves.toEqual(expect.any(Function));
    await expect(privatePost).rejects.toThrow('Forbidden');

    MockEventSource.instances[0]!.emit('message', {
      data: JSON.stringify({ subscriptionId: 'post-card', topic: 'post:12', data: { ok: true } }),
    } as MessageEvent);
    MockEventSource.instances[0]!.emit('message', {
      data: JSON.stringify({ subscriptionId: 'private-card', topic: 'post:private', data: {} }),
    } as MessageEvent);

    expect(postHandler).toHaveBeenCalledTimes(1);
    expect(privateHandler).not.toHaveBeenCalled();
  });

  it('keeps the previous subscription handler when replacement fails', async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      const operation = body.operations[0];
      return Response.json({
        accepted: true,
        connectionId: body.connectionId,
        results:
          operation.topic === 'post:blocked'
            ? [
                {
                  ok: false,
                  kind: 'subscribe',
                  id: operation.id,
                  error: { code: 'FORBIDDEN', message: 'Forbidden' },
                },
              ]
            : [{ ok: true, kind: operation.kind, id: operation.id, topic: operation.topic }],
      });
    });
    const oldHandler = vi.fn();
    const newHandler = vi.fn();
    const live = connectLiveStream('/live', {
      eventSource: MockEventSource,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const first = live.subscribe({ id: 'card', topic: 'post:12', onEvent: oldHandler });
    await Promise.resolve();
    MockEventSource.instances[0]!.emit('open', new Event('open'));
    await first;

    await expect(
      live.subscribe({ id: 'card', topic: 'post:blocked', onEvent: newHandler }),
    ).rejects.toThrow('Forbidden');

    MockEventSource.instances[0]!.emit('message', {
      data: JSON.stringify({ subscriptionId: 'card', topic: 'post:12', data: { ok: true } }),
    } as MessageEvent);

    expect(oldHandler).toHaveBeenCalledTimes(1);
    expect(newHandler).not.toHaveBeenCalled();
  });

  it('does not let stale unsubscribe functions remove replacement subscriptions', async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      return Response.json({
        accepted: true,
        connectionId: body.connectionId,
        results: body.operations.map((op: { kind: string; id: string; topic?: string }) => ({
          ok: true,
          kind: op.kind,
          id: op.id,
          topic: op.topic,
        })),
      });
    });
    const oldHandler = vi.fn();
    const newHandler = vi.fn();
    const live = connectLiveStream('/live', {
      eventSource: MockEventSource,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const firstUnsubscribe = live.subscribe({
      id: 'card',
      topic: 'post:12',
      onEvent: oldHandler,
    });
    await Promise.resolve();
    MockEventSource.instances[0]!.emit('open', new Event('open'));
    const unsubscribeOld = await firstUnsubscribe;
    await flushMicrotasks();

    const secondUnsubscribe = live.subscribe({
      id: 'card',
      topic: 'post:13',
      onEvent: newHandler,
    });
    const unsubscribeNew = await secondUnsubscribe;
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await unsubscribeOld();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    MockEventSource.instances[0]!.emit('message', {
      data: JSON.stringify({ subscriptionId: 'card', topic: 'post:13', data: { ok: true } }),
    } as MessageEvent);
    expect(oldHandler).not.toHaveBeenCalled();
    expect(newHandler).toHaveBeenCalledTimes(1);

    await unsubscribeNew();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not let stale unsubscribe functions race in-flight replacements', async () => {
    let resolveReplacement: ((value: Response | PromiseLike<Response>) => void) | undefined;
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      if (body.operations[0]?.topic === 'post:13') {
        return await new Promise<Response>((resolve) => {
          resolveReplacement = resolve;
        });
      }
      return Response.json({
        accepted: true,
        connectionId: body.connectionId,
        results: body.operations.map((op: { kind: string; id: string; topic?: string }) => ({
          ok: true,
          kind: op.kind,
          id: op.id,
          topic: op.topic,
        })),
      });
    });
    const oldHandler = vi.fn();
    const newHandler = vi.fn();
    const live = connectLiveStream('/live', {
      eventSource: MockEventSource,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const firstUnsubscribe = live.subscribe({
      id: 'card',
      topic: 'post:12',
      onEvent: oldHandler,
    });
    await Promise.resolve();
    MockEventSource.instances[0]!.emit('open', new Event('open'));
    const unsubscribeOld = await firstUnsubscribe;

    const secondUnsubscribe = live.subscribe({
      id: 'card',
      topic: 'post:13',
      onEvent: newHandler,
    });
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await unsubscribeOld();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveReplacement!(
      Response.json({
        accepted: true,
        connectionId: 'connection',
        results: [{ ok: true, kind: 'subscribe', id: 'card', topic: 'post:13' }],
      }),
    );
    const unsubscribeNew = await secondUnsubscribe;

    MockEventSource.instances[0]!.emit('message', {
      data: JSON.stringify({ subscriptionId: 'card', topic: 'post:13', data: { ok: true } }),
    } as MessageEvent);
    expect(oldHandler).not.toHaveBeenCalled();
    expect(newHandler).toHaveBeenCalledTimes(1);

    await unsubscribeNew();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('serializes control requests while a previous flush is in flight', async () => {
    let resolveReplacement: ((value: Response | PromiseLike<Response>) => void) | undefined;
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      if (body.operations[0]?.topic === 'post:13') {
        return await new Promise<Response>((resolve) => {
          resolveReplacement = resolve;
        });
      }
      return Response.json({
        accepted: true,
        connectionId: body.connectionId,
        results: body.operations.map((op: { kind: string; id: string; topic?: string }) => ({
          ok: true,
          kind: op.kind,
          id: op.id,
          topic: op.topic,
        })),
      });
    });
    const live = connectLiveStream('/live', {
      eventSource: MockEventSource,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const first = live.subscribe({ id: 'card', topic: 'post:12' });
    await Promise.resolve();
    MockEventSource.instances[0]!.emit('open', new Event('open'));
    await first;
    await flushMicrotasks();

    const replacement = live.subscribe({ id: 'card', topic: 'post:13' });
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const newest = live.subscribe({ id: 'card', topic: 'post:14' });
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveReplacement!(
      Response.json({
        accepted: true,
        connectionId: 'connection',
        results: [{ ok: true, kind: 'subscribe', id: 'card', topic: 'post:13' }],
      }),
    );
    await replacement;
    await newest;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1]![1]?.body)).toContain('"topic":"post:13"');
    expect(String(fetchMock.mock.calls[2]![1]?.body)).toContain('"topic":"post:14"');
  });

  it('reconnects and resubscribes active subscriptions with lastEventId', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      return Response.json({
        accepted: true,
        connectionId: body.connectionId,
        results: body.operations.map((op: { kind: string; id: string; topic?: string }) => ({
          ok: true,
          kind: op.kind,
          id: op.id,
          topic: op.topic,
        })),
      });
    });
    const live = connectLiveStream('/live', {
      eventSource: MockEventSource,
      fetch: fetchMock as unknown as typeof fetch,
      retryDelay: 25,
    });
    const unsubscribe = live.subscribe({ id: 'post-card', topic: 'post:12', lastEventId: 'v1' });
    await Promise.resolve();
    const firstSource = MockEventSource.instances[0]!;
    firstSource.emit('open', new Event('open'));
    await unsubscribe;

    firstSource.emit('message', {
      data: JSON.stringify({
        subscriptionId: 'post-card',
        topic: 'post:12',
        eventId: 'v2',
        data: {},
      }),
    } as MessageEvent);
    firstSource.emit('error', new Event('error'));
    expect(firstSource.closed).toBe(true);

    await vi.advanceTimersByTimeAsync(25);
    const secondSource = MockEventSource.instances[1]!;
    secondSource.emit('open', new Event('open'));
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenLastCalledWith('/live', {
      method: 'POST',
      headers: expect.any(Headers),
      credentials: 'same-origin',
      body: expect.stringContaining('"lastEventId":"v2"'),
    });
  });

  it('preserves resubscribe when a control operation interrupts a reconnect timer', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      return Response.json({
        accepted: true,
        connectionId: body.connectionId,
        results: body.operations.map((op: { kind: string; id: string; topic?: string }) => ({
          ok: true,
          kind: op.kind,
          id: op.id,
          topic: op.topic,
        })),
      });
    });
    const live = connectLiveStream('/live', {
      eventSource: MockEventSource,
      fetch: fetchMock as unknown as typeof fetch,
      retryDelay: 25,
    });
    const first = live.subscribe({ id: 'post-card', topic: 'post:12', lastEventId: 'v1' });
    await Promise.resolve();
    const firstSource = MockEventSource.instances[0]!;
    firstSource.emit('open', new Event('open'));
    await first;
    await flushMicrotasks();

    firstSource.emit('message', {
      data: JSON.stringify({
        subscriptionId: 'post-card',
        topic: 'post:12',
        eventId: 'v2',
        data: {},
      }),
    } as MessageEvent);
    firstSource.emit('error', new Event('error'));

    const second = live.subscribe({ id: 'comments', topic: 'comment:2323' });
    await flushMicrotasks();
    const secondSource = MockEventSource.instances[1]!;
    secondSource.emit('open', new Event('open'));
    await second;

    expect(fetchMock).toHaveBeenLastCalledWith('/live', {
      method: 'POST',
      headers: expect.any(Headers),
      credentials: 'same-origin',
      body: expect.stringContaining('"id":"post-card"'),
    });
    expect(String(fetchMock.mock.calls.at(-1)?.[1]?.body)).toContain('"id":"comments"');
    expect(String(fetchMock.mock.calls.at(-1)?.[1]?.body)).toContain('"lastEventId":"v2"');

    await vi.advanceTimersByTimeAsync(25);
    expect(MockEventSource.instances).toHaveLength(2);
  });
});

async function flushMicrotasks(count = 5): Promise<void> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
  }
}
