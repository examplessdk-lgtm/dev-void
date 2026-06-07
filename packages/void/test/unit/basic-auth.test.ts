import { Hono } from 'hono';
import { describe, expect, it } from 'vite-plus/test';
import { env } from '../../src/runtime/env-public.ts';
import { withRuntimeEnv } from '../../src/runtime/env.ts';
import { basicAuth, type BasicAuthOptions, type CloudEnv } from '../../src/runtime/handler.ts';

function authorization(value: string) {
  const bytes = new TextEncoder().encode(value);
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  return `Basic ${btoa(binary)}`;
}

function createApp(options: BasicAuthOptions) {
  const app = new Hono<CloudEnv>();

  app.use('*', basicAuth(options));
  app.all('*', (c) => c.text('ok'));

  return app;
}

describe('basicAuth', () => {
  it('challenges requests without credentials', async () => {
    const app = createApp({ username: 'guest', password: 'wedding', realm: 'Preview' });

    const res = await app.request('http://localhost/');

    expect(res.status).toBe(401);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('WWW-Authenticate')).toBe('Basic realm="Preview", charset="UTF-8"');
    expect(await res.text()).toBe('Authentication required');
  });

  it('challenges malformed and incorrect credentials', async () => {
    const app = createApp({ username: 'guest', password: 'wedding' });

    const malformed = await app.request('http://localhost/', {
      headers: { Authorization: 'Basic not-base64' },
    });
    const wrong = await app.request('http://localhost/', {
      headers: { Authorization: authorization('guest:wrong') },
    });

    expect(malformed.status).toBe(401);
    expect(wrong.status).toBe(401);
  });

  it('allows matching credentials', async () => {
    const app = createApp({ username: 'guest', password: 'wedding' });

    const res = await app.request('http://localhost/', {
      headers: { Authorization: authorization('guest:wedding') },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('defers lazy env-backed credentials until request env is bound', async () => {
    const options: BasicAuthOptions = {
      username: () => env.BASIC_AUTH_USERNAME as string,
      password: () => env.BASIC_AUTH_PASSWORD as string,
      realm: () => env.BASIC_AUTH_REALM as string,
    };

    expect(() => createApp(options)).not.toThrow();

    const app = createApp(options);
    const unauthenticated = await withRuntimeEnv(
      {
        BASIC_AUTH_USERNAME: 'guest',
        BASIC_AUTH_PASSWORD: 'wedding',
        BASIC_AUTH_REALM: 'Preview',
      },
      () => app.request('http://localhost/'),
    );
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('WWW-Authenticate')).toBe(
      'Basic realm="Preview", charset="UTF-8"',
    );

    const authenticated = await withRuntimeEnv(
      {
        BASIC_AUTH_USERNAME: 'guest',
        BASIC_AUTH_PASSWORD: 'wedding',
        BASIC_AUTH_REALM: 'Preview',
      },
      () =>
        app.request('http://localhost/', {
          headers: { Authorization: authorization('guest:wedding') },
        }),
    );

    expect(authenticated.status).toBe(200);
    expect(await authenticated.text()).toBe('ok');
  });

  it('supports UTF-8 credentials and colons in passwords', async () => {
    const app = createApp({ username: 'gåst', password: 'wed:ding' });

    const res = await app.request('http://localhost/', {
      headers: { Authorization: authorization('gåst:wed:ding') },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('escapes the realm in the challenge header', async () => {
    const app = createApp({
      username: 'guest',
      password: 'wedding',
      realm: 'staging "preview"',
    });

    const res = await app.request('http://localhost/');

    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Basic realm="staging \\"preview\\"", charset="UTF-8"',
    );
  });

  it('skips Void internal endpoints', async () => {
    const app = createApp({ username: 'guest', password: 'wedding' });

    const res = await app.request('http://localhost/__void/migrate', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('does not trust x-void-internal on public paths', async () => {
    const app = createApp({ username: 'guest', password: 'wedding' });

    const res = await app.request('http://localhost/', {
      headers: { 'x-void-internal': 'spoofed' },
    });

    expect(res.status).toBe(401);
  });
});
