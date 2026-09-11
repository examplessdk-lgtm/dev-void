import type { ApiRoutes } from '@voidcloud/api/api';
import type { Context } from 'hono';
import { hc, type InferResponseType } from 'hono/client';

export type Client = ReturnType<typeof hc<ApiRoutes>>;
export type ApiResponse = Pick<
  Response,
  'headers' | 'json' | 'ok' | 'status' | 'statusText' | 'text'
>;

/** Extract the 200 JSON response type from an hc client route key. */
export type API<K extends keyof B, B = Client> = InferResponseType<
  B[K] extends { $get: infer G } ? G : B[K],
  200
>;

const API_URL = 'https://api.void.cloud';
const DEFAULT_API_TIMEOUT_MS = 10_000;

function getApiUrl(context: Context): string {
  return (context.env as Record<string, string | undefined>).API_URL ?? API_URL;
}

function isLocalHost(context: Context): boolean {
  const host = context.req.header('host') ?? '';
  return host.startsWith('localhost') || host.startsWith('127.0.0.1');
}

/**
 * Use service binding in deployed dashboard workers. In local dev, always use
 * HTTP so production-backed dashboard testing cannot accidentally route to a
 * local or unresolved service binding.
 */
function getApiFetch(context: Context): typeof fetch {
  const binding = (context.env as { API?: Fetcher }).API;
  if (binding && !isLocalHost(context)) {
    return binding.fetch.bind(binding);
  }
  return globalThis.fetch;
}

function getApiTimeoutMs(context: Context): number {
  const raw = (context.env as Record<string, string | undefined>).API_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_API_TIMEOUT_MS;
  }

  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_API_TIMEOUT_MS;
}

function withTimeout(init: RequestInit | undefined, timeoutMs: number): RequestInit | undefined {
  if (init?.signal || typeof AbortSignal.timeout !== 'function') {
    return init;
  }
  return { ...init, signal: AbortSignal.timeout(timeoutMs) };
}

function getTimedApiFetch(context: Context): typeof fetch {
  const apiFetch = getApiFetch(context);
  const timeoutMs = getApiTimeoutMs(context);
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    apiFetch(input, withTimeout(init, timeoutMs))) as typeof fetch;
}

function getToken(context: Context): string | undefined {
  return context.get('token') as string | undefined;
}

function getCfAccessHeaders(context: Context): Record<string, string> {
  const env = context.env as Record<string, string | undefined>;
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    return {
      'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
      'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET,
    };
  }
  if (env.CF_ACCESS_TOKEN) {
    return { 'cf-access-token': env.CF_ACCESS_TOKEN };
  }
  return {};
}

export function getHeaders(context: Context, headers?: HeadersInit): Headers {
  const out = new Headers(headers);
  if (!out.has('Accept')) {
    out.set('Accept', 'application/json');
  }
  for (const [key, value] of Object.entries(getCfAccessHeaders(context))) {
    out.set(key, value);
  }

  const token = getToken(context);
  if (token) {
    out.set('Authorization', `Bearer ${token}`);
  }
  return out;
}

export function getPublicApiUrl(context: Context): string {
  return getApiUrl(context);
}

export function getApiOrigin(context: Context): string {
  return new URL(getApiUrl(context)).origin;
}

export function getApiClientFetch(context: Context): typeof fetch {
  return getApiFetch(context);
}

export async function fetchApi(
  context: Context,
  path: string,
  options?: RequestInit,
): Promise<Response> {
  const headers = getHeaders(context, options?.headers);
  if (options?.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return getTimedApiFetch(context)(`${getApiUrl(context)}${path}`, {
    ...options,
    headers,
  });
}

/** Use service binding when available (production), fall back to HTTP (local dev). */
export function createClient(context: Context) {
  const token = getToken(context);
  const baseUrl = getApiUrl(context);
  const headers = getCfAccessHeaders(context);
  headers.Accept = 'application/json';
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return hc<ApiRoutes>(baseUrl, {
    fetch: getTimedApiFetch(context),
    headers,
  });
}

export async function getApiErrorMessage(res: ApiResponse): Promise<string> {
  const body = await res.text();
  if (!body) {
    return `${res.status} ${res.statusText}`;
  }

  try {
    const json = JSON.parse(body) as { error?: unknown; message?: unknown };
    if (typeof json.error === 'string') {
      return json.error;
    }
    if (typeof json.message === 'string') {
      return json.message;
    }
  } catch {
    // Plain text error body.
  }

  return body;
}

export async function readApiJson<T>(res: ApiResponse): Promise<T | null> {
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    const body = await res.text();
    const preview = body.trim().replace(/\s+/g, ' ').slice(0, 160);
    console.warn(
      `[dashboard] expected JSON from API, got ${contentType || 'unknown content type'}${preview ? `: ${preview}` : ''}`,
    );
    return null;
  }

  try {
    return (await res.json()) as T;
  } catch (error) {
    console.warn(
      `[dashboard] failed to parse API JSON response: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

export async function getCurrentUser(context: Context): Promise<API<'me'> | null> {
  let res: Response;
  try {
    res = await fetchApi(context, '/me');
  } catch (error) {
    console.warn(
      `[dashboard] /me request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }

  if (!res.ok) {
    console.warn(`[dashboard] /me returned ${res.status}: ${await getApiErrorMessage(res)}`);
    return null;
  }
  return readApiJson<API<'me'>>(res);
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api(
  context: Context,
  path: string,
  options?: RequestInit,
): Promise<Response> {
  const res = await fetchApi(context, path, options);
  if (!res.ok) {
    throw new ApiError(res.status, await getApiErrorMessage(res));
  }
  return res;
}
