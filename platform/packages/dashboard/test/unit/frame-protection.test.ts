import { Hono } from 'hono';
import { describe, expect, it } from 'vite-plus/test';
import frameProtection from '../../middleware/00.frame-protection.ts';

function createApp() {
  const app = new Hono();
  app.use('*', frameProtection as never);
  app.get('/', (c) => c.html('<!doctype html><p>Projects</p>'));
  app.get('/data', (c) => c.json({ ok: true }));
  app.get('/elsewhere', (c) => c.redirect('/login'));
  return app;
}

describe('dashboard frame protection', () => {
  it('refuses framing of HTML pages', async () => {
    const res = await createApp().request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Projects');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
  });

  it('leaves non-HTML responses unchanged', async () => {
    const app = createApp();
    const json = await app.request('/data');
    expect(await json.json()).toEqual({ ok: true });
    expect(json.headers.get('x-frame-options')).toBeNull();
    expect(json.headers.get('content-security-policy')).toBeNull();

    const redirect = await app.request('/elsewhere');
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('x-frame-options')).toBeNull();
  });
});
