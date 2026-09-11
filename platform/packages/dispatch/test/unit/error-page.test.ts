import { describe, expect, it } from 'vite-plus/test';
import { createErrorResponse, shouldServeHtmlErrorPage } from '../../src/error-page.ts';

describe('dispatch default error pages', () => {
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
