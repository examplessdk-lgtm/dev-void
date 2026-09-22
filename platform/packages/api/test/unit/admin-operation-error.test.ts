import { Hono } from 'hono';
import { describe, expect, it } from 'vite-plus/test';
import { renderOperationError } from '../../src/admin/operation-error.tsx';
import type { ApiEnv } from '../../src/env.ts';
import { OperatorError } from '../../src/operator/common.ts';

describe('admin operation rejection rendering', () => {
  it('preserves the explanation and status while escaping text and offering a safe return link', async () => {
    const app = new Hono<ApiEnv>().onError(renderOperationError).post('/action', () => {
      throw new OperatorError(409, 'Cannot remove <script>owner</script>.', 'conflict', {
        privateDetail: 'not public',
      });
    });
    const response = await app.request('/action', { method: 'POST' });
    expect(response.status).toBe(409);
    const html = await response.text();
    expect(html).toContain('Cannot remove &lt;script&gt;owner&lt;/script&gt;.');
    expect(html).toContain('href="/admin/"');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('not public');
  });

  it('offers sign-in recovery when an operation requires authentication', async () => {
    const app = new Hono<ApiEnv>().onError(renderOperationError).post('/action', () => {
      throw new OperatorError(401, 'Sign in again to continue.');
    });
    const response = await app.request('/action', { method: 'POST' });
    expect(response.status).toBe(401);
    expect(await response.text()).toContain('href="/admin/logout">Sign in again</a>');
  });

  it('leaves unexpected exceptions to the application error handler', async () => {
    const failure = new Error('private database connection details');
    const admin = new Hono<ApiEnv>().onError(renderOperationError).get('/', () => {
      throw failure;
    });
    const app = new Hono<ApiEnv>()
      .onError((error, context) => {
        expect(error).toBe(failure);
        return context.text('Internal Server Error', 500);
      })
      .route('/admin', admin);

    const response = await app.request('/admin');
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Internal Server Error');
  });
});
