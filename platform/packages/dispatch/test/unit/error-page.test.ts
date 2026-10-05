import { describe, expect, it } from 'vite-plus/test';
import {
  createErrorResponse,
  createMaintenanceResponse,
  shouldServeHtmlErrorPage,
} from '../../src/error-page.ts';

describe('dispatch default error pages', () => {
  it('offers a manual retry on an uncached maintenance document', async () => {
    const response = createMaintenanceResponse(
      new Request('https://example.com/account?secret=private', {
        headers: { Accept: 'text/html' },
      }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Retry-After')).toBe('30');
    const html = await response.text();
    expect(html).toContain('Temporarily unavailable');
    expect(html).toContain('Try again');
    expect(html).not.toContain('private');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('http-equiv="refresh"');
  });

  it.each([
    ['/api/write', 'GET', 'text/html'],
    ['/assets/app.js', 'GET', '*/*'],
    ['/form', 'POST', 'text/html'],
    ['/json', 'GET', 'application/json'],
  ])('keeps maintenance responses machine-readable for %s (%s)', async (path, method, accept) => {
    const response = createMaintenanceResponse(
      new Request(`https://example.com${path}`, { method, headers: { Accept: accept } }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('Content-Type')).not.toContain('text/html');
    expect(await response.text()).toBe('Platform disabled');
  });

  it.each(['/page', '/api/health'])('returns a bodyless maintenance HEAD for %s', async (path) => {
    const response = createMaintenanceResponse(
      new Request(`https://example.com${path}`, { method: 'HEAD' }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toBe('');
  });
  it('serves self-contained HTML for document 404s', async () => {
    const request = new Request('https://example.com/missing-page');
    const response = createErrorResponse(request, 404, 'Not Found');

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('text/html');
    await expect(response.text()).resolves.toContain('404: Not Found');
  });

  it('keeps asset requests as plain text', async () => {
    const request = new Request('https://example.com/missing.css');
    const response = createErrorResponse(request, 404, 'Not Found');

    expect(shouldServeHtmlErrorPage(request)).toBe(false);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).not.toContain('text/html');
    await expect(response.text()).resolves.toBe('Not Found');
  });

  it('keeps API requests as plain text', async () => {
    const request = new Request('https://example.com/api/missing');
    const response = createErrorResponse(request, 500, 'Internal Server Error');

    expect(shouldServeHtmlErrorPage(request)).toBe(false);
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).not.toContain('text/html');
    await expect(response.text()).resolves.toBe('Internal Server Error');
  });
});
