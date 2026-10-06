import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  renderRestartingPage,
  restartPlugin,
  sanitizeReturnPath,
} from '../../src/plugin-restart.ts';

type NodeHandler = (req: unknown, res: unknown, next: () => void) => void;

interface FakeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Runs the plugin's real `configureServer` against a minimal connect-style
 * stack, so the middlewares see Node-shaped req/res objects.
 */
function createFakeViteServer() {
  const stack: Array<{ route: string; handle: NodeHandler }> = [];
  const restart = vi.fn();
  const server = {
    restart,
    middlewares: {
      use(route: string, handle: NodeHandler) {
        stack.push({ route, handle });
      },
    },
  };
  const plugin = restartPlugin();
  (plugin.configureServer as (this: unknown, s: unknown) => void).call(plugin, server);

  function dispatch(
    method: string,
    url: string,
    headers: Record<string, string> = {},
    encrypted = false,
    rawUrl?: string,
  ): FakeResponse {
    const parsed = new URL(url, 'http://localhost:5173');
    const entry = stack.find((s) => parsed.pathname === s.route);
    if (!entry) {
      throw new Error(`no middleware for ${parsed.pathname}`);
    }
    const req = {
      method,
      // connect strips the mounted prefix from req.url.
      url: rawUrl ?? '/' + parsed.search,
      headers: { host: 'localhost:5173', ...headers },
      socket: { encrypted },
    };
    const out: FakeResponse = { status: 200, headers: {}, body: '' };
    const res = {
      writeHead(code: number, h?: Record<string, string>) {
        out.status = code;
        Object.assign(out.headers, h);
      },
      end(chunk?: string) {
        out.body = chunk ?? '';
      },
    };
    entry.handle(req, res, () => {
      throw new Error('unexpected next()');
    });
    return out;
  }

  return { dispatch, restart };
}

/** The navigation target the restarting page's inline script assigns. */
function targetOf(html: string): string {
  const match = /var target=(.*?);\n/.exec(html);
  if (!match) {
    throw new Error('no target in restarting page');
  }
  return JSON.parse(match[1]!) as string;
}

describe('sanitizeReturnPath', () => {
  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '//evil.com',
    '//evil.com/path',
    '/\\evil.com',
    'https://evil.com',
    'http://localhost:5173/',
    'evil.com',
    '/\t/evil.com',
    '/\n/evil.com',
    '/foo\u0000',
    '',
  ])('rejects %j', (value) => {
    expect(sanitizeReturnPath(value)).toBe('/');
  });

  it('falls back to / when the value is missing', () => {
    expect(sanitizeReturnPath(null)).toBe('/');
    expect(sanitizeReturnPath(undefined)).toBe('/');
  });

  it.each(['/', '/foo?x=1', '/a/b#c', '/search?q=%2F%2Fevil.com'])('accepts %j', (value) => {
    expect(sanitizeReturnPath(value)).toBe(value);
  });
});

describe('renderRestartingPage', () => {
  it('embeds the return path so it cannot close the script or break the string', () => {
    const html = renderRestartingPage('/x?a="</script><script>alert(1)</script>');
    expect(html).not.toContain('</script><script>alert(1)');
    expect(targetOf(html)).toBe('/x?a="</script><script>alert(1)</script>');
  });

  it('no longer reads the return value from location in the client', () => {
    expect(renderRestartingPage('/')).not.toContain('location.search');
  });
});

describe('restartPlugin middlewares', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['javascript:alert(document.domain)', '//evil.com', 'https://evil.com'])(
    'GET /__void/restarting?return=%s navigates to /',
    (value) => {
      const { dispatch } = createFakeViteServer();
      const res = dispatch('GET', `/__void/restarting?return=${encodeURIComponent(value)}`);
      expect(res.status).toBe(200);
      expect(targetOf(res.body)).toBe('/');
    },
  );

  it('GET /__void/restarting keeps a same-origin return path', () => {
    const { dispatch } = createFakeViteServer();
    const res = dispatch('GET', `/__void/restarting?return=${encodeURIComponent('/foo?x=1')}`);
    expect(targetOf(res.body)).toBe('/foo?x=1');
  });

  it.each(['cross-site', 'same-site'])(
    'refuses GET /__void/restarting with Sec-Fetch-Site: %s',
    (site) => {
      const { dispatch } = createFakeViteServer();
      const res = dispatch('GET', '/__void/restarting?return=%2Ffoo', { 'sec-fetch-site': site });
      expect(res.status).toBe(403);
      expect(res.headers['Content-Type']).toBe('text/plain');
      expect(res.body).not.toContain('var target=');
      expect(res.body).not.toContain('fetch("/__void/restart"');
    },
  );

  it.each([
    ['Sec-Fetch-Site: same-origin', { 'sec-fetch-site': 'same-origin' }],
    ['Sec-Fetch-Site: none', { 'sec-fetch-site': 'none' }],
    ['no Sec-Fetch-Site', {}],
  ])('serves GET /__void/restarting with %s', (_label, headers) => {
    const { dispatch } = createFakeViteServer();
    const res = dispatch('GET', '/__void/restarting?return=%2Ffoo', headers);
    expect(res.status).toBe(200);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(targetOf(res.body)).toBe('/foo');
  });

  it('serves GET /__void/restarting with a request url that does not parse', () => {
    const { dispatch } = createFakeViteServer();
    const res = dispatch('GET', '/__void/restarting', {}, false, '//[');
    expect(res.status).toBe(200);
    expect(targetOf(res.body)).toBe('/');
  });

  it.each([
    ['cross-site Sec-Fetch-Site', { 'sec-fetch-site': 'cross-site', origin: 'https://evil.com' }],
    [
      'same-site Sec-Fetch-Site',
      { 'sec-fetch-site': 'same-site', origin: 'http://localhost:3000' },
    ],
    ['a foreign Origin', { origin: 'https://evil.com' }],
    ['a different port', { origin: 'http://localhost:3000' }],
    ['a different scheme', { origin: 'https://localhost:5173' }],
    ['a null Origin', { origin: 'null' }],
  ])('rejects a POST /__void/restart with %s', (_label, headers) => {
    vi.useFakeTimers();
    const { dispatch, restart } = createFakeViteServer();
    const res = dispatch('POST', '/__void/restart', headers);
    expect(res.status).toBe(403);
    vi.runAllTimers();
    expect(restart).not.toHaveBeenCalled();
    expect(dispatch('GET', '/__void/ping').status).toBe(200);
  });

  it.each([
    [
      'same-origin Sec-Fetch-Site',
      { 'sec-fetch-site': 'same-origin', origin: 'http://localhost:5173' },
    ],
    ['a matching Origin', { origin: 'http://localhost:5173' }],
    ['no browser origin headers', {}],
  ])('accepts a POST /__void/restart with %s', (_label, headers) => {
    vi.useFakeTimers();
    const { dispatch, restart } = createFakeViteServer();
    const res = dispatch('POST', '/__void/restart', headers);
    expect(res.status).toBe(200);
    expect(dispatch('GET', '/__void/ping').status).toBe(503);
    vi.runAllTimers();
    expect(restart).toHaveBeenCalledOnce();
  });

  it('matches the Origin scheme against an HTTPS dev server', () => {
    vi.useFakeTimers();
    const { dispatch } = createFakeViteServer();
    expect(
      dispatch('POST', '/__void/restart', { origin: 'https://localhost:5173' }, true).status,
    ).toBe(200);
  });

  it('still answers 405 to a non-POST /__void/restart', () => {
    const { dispatch } = createFakeViteServer();
    expect(dispatch('GET', '/__void/restart').status).toBe(405);
  });
});
