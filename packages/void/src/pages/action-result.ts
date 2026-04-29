import type { PageObject } from './protocol.ts';

export type ActionErrorHandlingScope = 'callSite' | 'boundary';

export type ActionResult<T = PageObject | undefined> =
  | { ok: true; pageData: T }
  | { ok: false; error: VoidActionError };

export class VoidActionError extends Error {
  readonly body: unknown;
  readonly status: number;
  readonly statusText: string;
  readonly url: string;

  constructor({
    body,
    status,
    statusText,
    url,
  }: {
    body: unknown;
    status: number;
    statusText: string;
    url: string;
  }) {
    super(
      statusText ? `Action failed with ${status} ${statusText}` : `Action failed with ${status}`,
    );
    this.name = 'VoidActionError';
    this.body = body;
    this.status = status;
    this.statusText = statusText;
    this.url = url;
  }
}

export function categorizeActionError(status: number): ActionErrorHandlingScope {
  switch (status) {
    case 400:
    case 402:
    case 404:
    case 408:
    case 409:
    case 412:
    case 413:
    case 415:
    case 422:
    case 429:
    case 499:
      return 'callSite';

    case 401:
    case 403:
    case 405:
    case 428:
    case 500:
    case 501:
    case 502:
    case 503:
    case 504:
    default:
      return 'boundary';
  }
}

export function isCallSiteActionError(error: unknown): error is VoidActionError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'VoidActionError' &&
    'status' in error &&
    typeof error.status === 'number' &&
    categorizeActionError(error.status) === 'callSite'
  );
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

async function readActionErrorBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') || '';
  try {
    if (contentType.includes('application/json')) {
      return await response.json();
    }
    const text = await response.text();
    return text || null;
  } catch {
    return null;
  }
}

export async function createActionErrorFromResponse(
  response: Response,
  url: string,
): Promise<VoidActionError> {
  return new VoidActionError({
    body: await readActionErrorBody(response),
    status: response.status,
    statusText: response.statusText,
    url,
  });
}
