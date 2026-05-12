import { describe, expect, it } from 'vite-plus/test';
import type { CloudContext } from '../../src/runtime/handler.ts';
import { createLiveDurableObject } from '../../src/runtime/live-server.ts';
import { defineLiveStream, type LiveLimits } from '../../src/runtime/live.ts';

const LIMITS: LiveLimits = {
  maxSubscriptionsPerConnection: 256,
  maxSubscriptionsPerTopic: 64,
  maxOperationsPerControlRequest: 100,
  maxQueuedEventsPerConnection: 100,
  maxEncodedEventSize: 64 * 1024,
  deliveryAttemptTimeoutMs: 1_500,
};

describe('live Durable Object runtime', () => {
  it('rejects duplicate stream ids at startup', () => {
    const id = `duplicate-${crypto.randomUUID()}`;
    defineLiveStream({ id, allowAnonymousControl: true });
    expect(() => defineLiveStream({ id, allowAnonymousControl: true })).toThrow(
      `live: duplicate stream id "${id}".`,
    );
  });

  it('rejects invalid live limits before registering the stream id', () => {
    const id = `limits-${crypto.randomUUID()}`;

    expect(() =>
      defineLiveStream({
        id,
        allowAnonymousControl: true,
        limits: { maxQueuedEventsPerConnection: Number.NaN },
      }),
    ).toThrow('limits.maxQueuedEventsPerConnection must be a positive finite integer');
    expect(() =>
      defineLiveStream({
        id,
        allowAnonymousControl: true,
        limits: { maxSubscriptionsPerTopic: 257 },
      }),
    ).toThrow('limits.maxSubscriptionsPerTopic must be at most 256');
    expect(() => defineLiveStream({ id, allowAnonymousControl: true })).not.toThrow();
  });

  it('returns per-operation errors for invalid control operations', async () => {
    const harness = createHarness();
    const stream = defineLiveStream({
      id: `control-${crypto.randomUUID()}`,
      allowAnonymousControl: true,
    });
    const connectionId = 'connection-control-1';
    const connectResponse = await stream.connect(
      liveContext(harness.env, `https://void.live/live?connectionId=${connectionId}`),
    );
    const reader = connectResponse.body!.getReader();
    await readFrame(reader);

    const controlResponse = await stream.control(
      liveContext(harness.env, 'https://void.live/live', {
        connectionId,
        operations: [
          { kind: 'subscribe', id: 'valid-card', topic: 'post:12' },
          { kind: 'subscribe', id: 'bad-topic', topic: '' },
          { kind: 'unsubscribe', id: 'bad\nid' },
        ],
      }),
    );
    const body = await controlResponse.json();

    expect(controlResponse.ok).toBe(true);
    expect(body).toMatchObject({
      accepted: true,
      results: [
        { ok: true, kind: 'subscribe', id: 'valid-card', topic: 'post:12' },
        { ok: false, kind: 'subscribe', id: 'bad-topic', error: { code: 'INVALID_TOPIC' } },
        { ok: false, kind: 'unsubscribe', error: { code: 'INVALID_SUBSCRIPTION_ID' } },
      ],
    });
    await reader.cancel();
  });

  it('prunes stale topic rows before enforcing the topic cap', async () => {
    const harness = createHarness();
    const topic = harness.stub('live:app:topic:topic-key');
    const limits = { ...LIMITS, maxSubscriptionsPerTopic: 1 };

    const stale = await topic.fetch(
      jsonRequest('/register', {
        streamId: 'app',
        topic: 'post:12',
        topicKey: 'topic-key',
        connectionId: 'stale-connection-0001',
        subscriptionId: 'comments',
        generation: 1,
        revision: 1,
        lastSeenAt: Date.now(),
        limits,
      }),
    );
    expect(stale.ok).toBe(true);

    const current = await topic.fetch(
      jsonRequest('/register', {
        streamId: 'app',
        topic: 'post:12',
        topicKey: 'topic-key',
        connectionId: 'current-connection-001',
        subscriptionId: 'comments',
        generation: 1,
        revision: 1,
        lastSeenAt: Date.now(),
        limits,
      }),
    );
    expect(current.ok).toBe(true);
  });

  it('bounds publish delivery attempts', async () => {
    const LiveDurableObject = createLiveDurableObject();
    const state = createState();
    const env = {
      VOID_LIVE: {
        idFromName(name: string) {
          return name as unknown as DurableObjectId;
        },
        get() {
          return {
            fetch() {
              return new Promise<Response>(() => {});
            },
          } as unknown as DurableObjectStub;
        },
      } as unknown as DurableObjectNamespace,
    };
    const topic = new LiveDurableObject(state, env);
    const limits = { ...LIMITS, deliveryAttemptTimeoutMs: 10 };

    await topic.fetch(
      jsonRequest('/register', {
        streamId: 'app',
        topic: 'post:12',
        topicKey: 'topic-key',
        connectionId: 'slow-connection-0001',
        subscriptionId: 'comments',
        generation: 1,
        revision: 1,
        lastSeenAt: Date.now(),
        limits,
      }),
    );

    const startedAt = Date.now();
    const response = await topic.fetch(
      jsonRequest('/publish', {
        streamId: 'app',
        topic: 'post:12',
        topicKey: 'topic-key',
        data: { body: 'hello' },
        limits,
      }),
    );

    expect(response.ok).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('serializes publishes for one topic so slow stale connections cannot reorder events', async () => {
    let slowCalls = 0;
    let resolveSlowFirst: ((response: Response) => void) | undefined;
    let markSlowFirstStarted: (() => void) | undefined;
    const slowFirstStarted = new Promise<void>((resolve) => {
      markSlowFirstStarted = resolve;
    });
    const harness = createHarness({
      fetch(name, request) {
        if (
          name === 'live:app:connection:slow-connection-0001' &&
          new URL(request.url).pathname === '/deliver'
        ) {
          slowCalls++;
          if (slowCalls === 1) {
            return new Promise<Response>((resolve) => {
              markSlowFirstStarted!();
              resolveSlowFirst = resolve;
            });
          }
          return Promise.resolve(new Response('connection missing', { status: 410 }));
        }
      },
    });
    const topicKey = await topicDigest('app', 'post:12');
    const topic = harness.stub(`live:app:topic:${topicKey}`);
    await topic.fetch(
      jsonRequest('/register', {
        streamId: 'app',
        topic: 'post:12',
        topicKey,
        connectionId: 'slow-connection-0001',
        subscriptionId: 'slow-card',
        generation: 1,
        revision: 1,
        lastSeenAt: Date.now(),
        limits: LIMITS,
      }),
    );

    const connectionId = 'connection-order-001';
    const connection = harness.stub(`live:app:connection:${connectionId}`);
    const response = await connection.fetch(
      jsonRequest('/connect', {
        streamId: 'app',
        connectionId,
        owner: 'user:1',
        limits: LIMITS,
      }),
    );
    const reader = response.body!.getReader();
    await readFrame(reader);
    await connection.fetch(
      jsonRequest('/control', {
        streamId: 'app',
        connectionId,
        owner: 'user:1',
        limits: LIMITS,
        operations: [{ kind: 'subscribe', id: 'post-card', topic: 'post:12' }],
      }),
    );

    const firstPublish = harness.publish('app', 'post:12', { seq: 1 });
    await slowFirstStarted;
    const secondPublish = harness.publish('app', 'post:12', { seq: 2 });
    await Promise.resolve();
    await Promise.resolve();
    resolveSlowFirst!(new Response('connection missing', { status: 410 }));

    expect(parseData(await readFrame(reader))).toMatchObject({ data: { seq: 1 } });
    expect(parseData(await readFrame(reader))).toMatchObject({ data: { seq: 2 } });
    await Promise.all([firstPublish, secondPublish]);
    await reader.cancel();
  });

  it('rejects oversized live events instead of reporting successful publish', async () => {
    const harness = createHarness();
    const connectionId = 'connection-large-001';
    const connection = harness.stub(`live:app:connection:${connectionId}`);
    const response = await connection.fetch(
      jsonRequest('/connect', {
        streamId: 'app',
        connectionId,
        owner: 'user:1',
        limits: LIMITS,
      }),
    );
    const reader = response.body!.getReader();
    await readFrame(reader);
    await connection.fetch(
      jsonRequest('/control', {
        streamId: 'app',
        connectionId,
        owner: 'user:1',
        limits: LIMITS,
        operations: [{ kind: 'subscribe', id: 'post-card', topic: 'post:12' }],
      }),
    );

    const publishResponse = await harness.publish(
      'app',
      'post:12',
      { body: 'x'.repeat(200) },
      { ...LIMITS, maxEncodedEventSize: 80 },
    );
    const body = await publishResponse.json();

    expect(publishResponse.status).toBe(413);
    expect(body).toMatchObject({
      accepted: false,
      error: { code: 'PAYLOAD_TOO_LARGE' },
    });
    await reader.cancel();
  });

  it('keeps replacement successful when old topic unregister fails', async () => {
    const oldTopicKey = await topicDigest('app', 'post:12');
    const harness = createHarness({
      fetch(name, request) {
        if (
          name === `live:app:topic:${oldTopicKey}` &&
          new URL(request.url).pathname === '/unregister'
        ) {
          return Promise.reject(new Error('temporary unregister failure'));
        }
      },
    });
    const connectionId = 'connection-replace-1';
    const connection = harness.stub(`live:app:connection:${connectionId}`);
    const response = await connection.fetch(
      jsonRequest('/connect', {
        streamId: 'app',
        connectionId,
        owner: 'user:1',
        limits: LIMITS,
      }),
    );
    const reader = response.body!.getReader();
    await readFrame(reader);
    await connection.fetch(
      jsonRequest('/control', {
        streamId: 'app',
        connectionId,
        owner: 'user:1',
        limits: LIMITS,
        operations: [{ kind: 'subscribe', id: 'post-card', topic: 'post:12' }],
      }),
    );

    const replaceResponse = await connection.fetch(
      jsonRequest('/control', {
        streamId: 'app',
        connectionId,
        owner: 'user:1',
        limits: LIMITS,
        operations: [{ kind: 'subscribe', id: 'post-card', topic: 'post:13' }],
      }),
    );
    await expect(replaceResponse.json()).resolves.toMatchObject({
      accepted: true,
      results: [{ ok: true, kind: 'subscribe', id: 'post-card', topic: 'post:13' }],
    });

    await harness.publish('app', 'post:13', { title: 'Replacement' });
    expect(parseData(await readFrame(reader))).toMatchObject({
      subscriptionId: 'post-card',
      topic: 'post:13',
      data: { title: 'Replacement' },
    });
    await reader.cancel();
  });

  it('delivers multiple topics over one connection and unsubscribes individually', async () => {
    const harness = createHarness();
    const connectionId = 'connection-0000000001';
    const connection = harness.stub(`live:app:connection:${connectionId}`);
    const response = await connection.fetch(
      jsonRequest('/connect', {
        streamId: 'app',
        connectionId,
        owner: 'user:1',
        limits: LIMITS,
      }),
    );
    const reader = response.body!.getReader();
    await readFrame(reader);

    await connection.fetch(
      jsonRequest('/control', {
        streamId: 'app',
        connectionId,
        owner: 'user:1',
        limits: LIMITS,
        operations: [
          { kind: 'subscribe', id: 'post-card', topic: 'post:12' },
          { kind: 'subscribe', id: 'comments', topic: 'comment:2323' },
        ],
      }),
    );

    const postPublish = harness.publish('app', 'post:12', { title: 'Updated' });

    expect(parseData(await readFrame(reader))).toMatchObject({
      subscriptionId: 'post-card',
      topic: 'post:12',
      data: { title: 'Updated' },
    });
    await postPublish;

    const commentPublish = harness.publish('app', 'comment:2323', { count: 4 });
    expect(parseData(await readFrame(reader))).toMatchObject({
      subscriptionId: 'comments',
      topic: 'comment:2323',
      data: { count: 4 },
    });
    await commentPublish;

    await connection.fetch(
      jsonRequest('/control', {
        streamId: 'app',
        connectionId,
        owner: 'user:1',
        limits: LIMITS,
        operations: [{ kind: 'unsubscribe', id: 'post-card' }],
      }),
    );

    await harness.publish('app', 'post:12', { title: 'Ignored' });
    const nextCommentPublish = harness.publish('app', 'comment:2323', { count: 5 });

    expect(parseData(await readFrame(reader))).toMatchObject({
      subscriptionId: 'comments',
      topic: 'comment:2323',
      data: { count: 5 },
    });
    await nextCommentPublish;

    await reader.cancel();
  });

  it('removes previous generation topic rows when a connection reconnects', async () => {
    const harness = createHarness();
    const limits = { ...LIMITS, maxSubscriptionsPerTopic: 1 };
    const connectionId = 'connection-0000000002';
    const connection = harness.stub(`live:app:connection:${connectionId}`);
    const first = await connection.fetch(
      jsonRequest('/connect', {
        streamId: 'app',
        connectionId,
        owner: 'user:1',
        limits,
      }),
    );
    const firstReader = first.body!.getReader();
    await readFrame(firstReader);

    await connection.fetch(
      jsonRequest('/control', {
        streamId: 'app',
        connectionId,
        owner: 'user:1',
        limits,
        operations: [{ kind: 'subscribe', id: 'old-card', topic: 'post:12' }],
      }),
    );

    const second = await connection.fetch(
      jsonRequest('/connect', {
        streamId: 'app',
        connectionId,
        owner: 'user:1',
        limits,
      }),
    );
    const secondReader = second.body!.getReader();
    await readFrame(secondReader);

    const controlResponse = await connection.fetch(
      jsonRequest('/control', {
        streamId: 'app',
        connectionId,
        owner: 'user:1',
        limits,
        operations: [{ kind: 'subscribe', id: 'new-card', topic: 'post:12' }],
      }),
    );

    await expect(controlResponse.json()).resolves.toMatchObject({
      accepted: true,
      results: [{ ok: true, id: 'new-card', topic: 'post:12' }],
    });

    await firstReader.cancel().catch(() => {});
    await secondReader.cancel();
  });
});

function createHarness(options?: {
  fetch?: (name: string, request: Request) => Promise<Response> | undefined;
}) {
  const LiveDurableObject = createLiveDurableObject();
  const instances = new Map<string, { fetch(request: Request): Promise<Response> }>();
  const states = new Map<string, DurableObjectState>();
  const env = {} as { VOID_LIVE: DurableObjectNamespace };
  const namespace = {
    idFromName(name: string) {
      return name as unknown as DurableObjectId;
    },
    get(id: DurableObjectId) {
      const name = id as unknown as string;
      return {
        fetch(input: RequestInfo | URL, init?: RequestInit) {
          const request = input instanceof Request ? input : new Request(input, init);
          const response = options?.fetch?.(name, request);
          if (response) {
            return response;
          }
          let instance = instances.get(name);
          if (!instance) {
            const state = createState();
            states.set(name, state);
            instance = new LiveDurableObject(state, env);
            instances.set(name, instance);
          }
          return instance.fetch(request);
        },
      } as DurableObjectStub;
    },
  } as DurableObjectNamespace;
  env.VOID_LIVE = namespace;

  return {
    env,
    stub(name: string): DurableObjectStub {
      return namespace.get(namespace.idFromName(name));
    },
    async publish(streamId: string, topic: string, data: unknown, limits: LiveLimits = LIMITS) {
      const topicKey = await topicDigest(streamId, topic);
      const topicStub = namespace.get(namespace.idFromName(`live:${streamId}:topic:${topicKey}`));
      return topicStub.fetch(
        jsonRequest('/publish', {
          streamId,
          topic,
          topicKey,
          data,
          limits,
        }),
      );
    },
  };
}

function liveContext(env: unknown, url: string, body?: unknown): CloudContext {
  return {
    env,
    req: {
      raw: new Request(url, {
        method: body === undefined ? 'GET' : 'POST',
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    },
    get() {
      return undefined;
    },
  } as unknown as CloudContext;
}

function createState(): DurableObjectState {
  const values = new Map<string, unknown>();
  return {
    storage: {
      get(key: string) {
        return Promise.resolve(values.get(key));
      },
      put(key: string, value: unknown) {
        values.set(key, value);
        return Promise.resolve();
      },
      delete(keyOrKeys: string | Array<string>) {
        for (const key of Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]) {
          values.delete(key);
        }
        return Promise.resolve();
      },
      list(options?: { prefix?: string }) {
        const result = new Map<string, unknown>();
        for (const [key, value] of values) {
          if (!options?.prefix || key.startsWith(options.prefix)) {
            result.set(key, value);
          }
        }
        return Promise.resolve(result);
      },
      setAlarm() {
        return Promise.resolve();
      },
    },
  } as unknown as DurableObjectState;
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`https://void.live${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let frame = '';
  while (!frame.includes('\n\n')) {
    const result = await reader.read();
    if (result.done) {
      throw new Error('stream ended before frame');
    }
    frame += decoder.decode(result.value, { stream: true });
  }
  return frame.slice(0, frame.indexOf('\n\n'));
}

function parseData(frame: string): unknown {
  const data = frame
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length))
    .join('\n');
  return JSON.parse(data);
}

async function topicDigest(streamId: string, topic: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${streamId}\u0000${topic}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const binary = String.fromCharCode(...new Uint8Array(digest));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
