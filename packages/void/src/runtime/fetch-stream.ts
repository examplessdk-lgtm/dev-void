import { ofetch } from 'ofetch';
import { FetchError } from './fetch-error';
export { FetchError as StreamError };

import type { RouteMap } from 'void/routes';
type MethodsOf<P extends keyof RouteMap> = keyof RouteMap[P] & string;
type InputOf<P extends keyof RouteMap, M extends MethodsOf<P>> = RouteMap[P][M] extends {
  input: infer I;
}
  ? I
  : {};

type BodyOption<I> = 'body' extends keyof I
  ? { body: I['body' & keyof I] }
  : { body?: Record<string, unknown> | BodyInit | null };
type QueryOption<I> = 'query' extends keyof I
  ? { query: I['query' & keyof I] }
  : { query?: Record<string, string> };
type ParamsOption<I> = 'params' extends keyof I
  ? { params: I['params' & keyof I] }
  : { params?: Record<string, string> };

type StreamOptions<P extends keyof RouteMap, M extends MethodsOf<P>> = BodyOption<InputOf<P, M>> &
  QueryOption<InputOf<P, M>> &
  ParamsOption<InputOf<P, M>> & {
    method?: M;
    headers?: HeadersInit;
    signal?: AbortSignal;
    baseURL?: string;
  };

/**
 * Consume an SSE endpoint as an async generator of text chunks.
 *
 * Parses Workers AI SSE format (`data: {"response":"chunk"}` + `data: [DONE]`)
 * and plain text SSE (`data: some text`).
 *
 * ```ts
 * import { fetchStream } from "void/client";
 *
 * for await (const chunk of fetchStream("/api/ai/chat", {
 *   method: "POST",
 *   body: { messages: [{ role: "user", content: "Hello" }] },
 * })) {
 *   output += chunk;
 * }
 * ```
 *
 * @yields {string} Text chunks from SSE data frames.
 */
export async function* fetchStream<
  P extends keyof RouteMap & string,
  M extends MethodsOf<P> = 'POST' extends MethodsOf<P> ? 'POST' : MethodsOf<P>,
>(path: P, options?: StreamOptions<P, M>): AsyncGenerator<string, void, undefined> {
  // Interpolate :param segments
  let url: string = path;
  if (options?.params) {
    for (const [key, value] of Object.entries(options.params as Record<string, string>)) {
      url = url.replace(`:${key}`, encodeURIComponent(value));
    }
  }

  const response = await ofetch.raw(url, {
    method: (options?.method ?? 'POST') as string,
    body: options?.body as never,
    query: options?.query as never,
    headers: options?.headers,
    signal: options?.signal,
    baseURL: options?.baseURL,
    responseType: 'stream',
  });

  const body = response._data as ReadableStream<Uint8Array> | null;
  if (!body) {
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      const lines = buffer.split('\n');
      buffer = lines.pop()!; // Keep incomplete last line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) {
          continue;
        }

        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            return;
          }

          // Try to parse as Workers AI JSON response
          try {
            const parsed = JSON.parse(data);
            if (typeof parsed.response === 'string') {
              yield parsed.response;
              continue;
            }
            // Parsed JSON with non-string response (e.g. null + usage metadata) — skip
            if ('response' in parsed) {
              continue;
            }
          } catch {
            // Not JSON — yield as plain text
          }

          yield data;
        }
      }
    }

    // Process any remaining data in buffer
    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith('data: ')) {
        const data = trimmed.slice(6);
        if (data !== '[DONE]') {
          try {
            const parsed = JSON.parse(data);
            if (typeof parsed.response === 'string') {
              yield parsed.response;
            } else if (!('response' in parsed)) {
              yield data;
            }
          } catch {
            yield data;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
