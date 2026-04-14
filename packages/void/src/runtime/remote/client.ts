/**
 * HTTP client for the remote bindings proxy (proxy.void.cloud).
 *
 * Used by ProxyD1Database, ProxyKVNamespace, and ProxyR2Bucket to forward
 * binding operations to the platform proxy during local development.
 */
export class ProxyClient {
  constructor(
    private proxyUrl: string,
    private token: string,
    private projectId: string,
  ) {}

  /**
   * Send a JSON POST request to the proxy and return the response.
   * Injects `projectId` into the body and `Authorization` header.
   * Throws on non-OK responses.
   */
  async fetch(path: string, body: Record<string, unknown>): Promise<Response> {
    const res = await globalThis.fetch(`${this.proxyUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...body, projectId: this.projectId }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Remote proxy error (${res.status}): ${text}`);
    }
    return res;
  }

  /**
   * Send a request to the proxy and return the raw Response (for streaming).
   * Injects `Authorization` header and `projectId` into the JSON body.
   * Throws on non-OK responses.
   */
  async stream(path: string, init: RequestInit): Promise<Response> {
    // Inject projectId into the body if it's JSON
    let body = init.body;
    if (typeof body === 'string') {
      try {
        const parsed = JSON.parse(body);
        body = JSON.stringify({ ...parsed, projectId: this.projectId });
      } catch {
        // Not JSON, leave body as-is
      }
    }

    const res = await globalThis.fetch(`${this.proxyUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        Authorization: `Bearer ${this.token}`,
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Remote proxy error (${res.status}): ${text}`);
    }
    return res;
  }
}
