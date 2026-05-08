import { describe, expect, it, vi, beforeEach } from 'vite-plus/test';

// Mock ofetch before importing the module
vi.mock('ofetch', () => {
  return {
    ofetch: Object.assign(vi.fn(), {
      raw: vi.fn(),
    }),
    FetchError: class FetchError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'FetchError';
      }
    },
  };
});

declare module 'void/routes' {
  interface RouteMap {
    '/api/chat': {
      POST: { input: { body: { messages: Array<unknown> } }; output: unknown };
    };
    '/api/stream': {
      POST: { input: {}; output: unknown };
    };
  }
}

import { ofetch } from 'ofetch';
import { fetchStream } from '../../src/runtime/fetch-stream.ts';

function makeSSEStream(chunks: Array<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchStream', () => {
  it('parses Workers AI JSON SSE format', async () => {
    const stream = makeSSEStream([
      'data: {"response":"Hello"}\n\n',
      'data: {"response":" world"}\n\n',
      'data: [DONE]\n\n',
    ]);

    vi.mocked(ofetch.raw).mockResolvedValue({
      _data: stream,
      status: 200,
      headers: new Headers(),
    } as unknown as Awaited<ReturnType<typeof ofetch.raw>>);

    const chunks: Array<string> = [];
    for await (const chunk of fetchStream('/api/chat', {
      method: 'POST',
      body: { messages: [] },
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['Hello', ' world']);
  });

  it('parses plain text SSE data', async () => {
    const stream = makeSSEStream(['data: hello\n\n', 'data: world\n\n', 'data: [DONE]\n\n']);

    vi.mocked(ofetch.raw).mockResolvedValue({
      _data: stream,
      status: 200,
      headers: new Headers(),
    } as unknown as Awaited<ReturnType<typeof ofetch.raw>>);

    const chunks: Array<string> = [];
    for await (const chunk of fetchStream('/api/stream', { method: 'POST' })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['hello', 'world']);
  });

  it('handles chunked SSE data split across reads', async () => {
    const stream = makeSSEStream([
      'data: {"respo',
      'nse":"chunk1"}\n\ndata: {"response":"chunk2"}\n\n',
      'data: [DONE]\n\n',
    ]);

    vi.mocked(ofetch.raw).mockResolvedValue({
      _data: stream,
      status: 200,
      headers: new Headers(),
    } as unknown as Awaited<ReturnType<typeof ofetch.raw>>);

    const chunks: Array<string> = [];
    for await (const chunk of fetchStream('/api/stream', { method: 'POST' })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['chunk1', 'chunk2']);
  });

  it('ignores SSE comments (lines starting with :)', async () => {
    const stream = makeSSEStream([
      ': this is a comment\n',
      'data: {"response":"hello"}\n\n',
      'data: [DONE]\n\n',
    ]);

    vi.mocked(ofetch.raw).mockResolvedValue({
      _data: stream,
      status: 200,
      headers: new Headers(),
    } as unknown as Awaited<ReturnType<typeof ofetch.raw>>);

    const chunks: Array<string> = [];
    for await (const chunk of fetchStream('/api/stream', { method: 'POST' })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['hello']);
  });

  it('handles empty body gracefully', async () => {
    vi.mocked(ofetch.raw).mockResolvedValue({
      _data: null,
      status: 200,
      headers: new Headers(),
    } as unknown as Awaited<ReturnType<typeof ofetch.raw>>);

    const chunks: Array<string> = [];
    for await (const chunk of fetchStream('/api/stream', { method: 'POST' })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([]);
  });

  it('passes correct options to ofetch', async () => {
    const stream = makeSSEStream(['data: [DONE]\n\n']);

    vi.mocked(ofetch.raw).mockResolvedValue({
      _data: stream,
      status: 200,
      headers: new Headers(),
    } as unknown as Awaited<ReturnType<typeof ofetch.raw>>);

    for await (const _ of fetchStream('/api/chat', {
      method: 'POST',
      body: { messages: [] },
      headers: { 'x-custom': 'value' },
    })) {
      // Consume the generator to exhaust the mocked stream.
    }

    expect(ofetch.raw).toHaveBeenCalledWith('/api/chat', {
      method: 'POST',
      body: { messages: [] },
      query: undefined,
      headers: { 'x-custom': 'value' },
      signal: undefined,
      baseURL: undefined,
      responseType: 'stream',
    });
  });
});
