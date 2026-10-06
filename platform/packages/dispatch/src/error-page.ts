import { isApiPath } from './request-type.ts';

const DEFAULT_FONT_STACK =
  'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderDefaultErrorPage(status: number, title: string, maintenance = false): string {
  const heading = `${status}: ${title}`;
  const prefix = `${status}: `;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(heading)}</title>
    <style>
      :root {
        color-scheme: light;
        font-family: ${DEFAULT_FONT_STACK};
        background: #f5f5f5;
        color: #171717;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-block-size: 100dvh;
        display: grid;
        place-items: center;
        padding: 24px;
        background:
          radial-gradient(circle at top, rgba(255, 255, 255, 0.96), rgba(245, 245, 245, 0.96) 52%),
          linear-gradient(180deg, #fafafa 0%, #f1f1f1 100%);
        font: 500 16px/1.5 ${DEFAULT_FONT_STACK};
      }

      main {
        inline-size: min(100%, 560px);
        padding: 32px 36px;
        border: 1px solid #d4d4d8;
        border-radius: 32px;
        corner-shape: squircle;
        background: rgba(255, 255, 255, 0.88);
        text-align: center;
        backdrop-filter: blur(12px);
      }

      h1 {
        margin: 0;
        font: 400 clamp(1.5rem, 1.2rem + 1vw, 2rem) / 1.1 ${DEFAULT_FONT_STACK};
        letter-spacing: -0.03em;
      }

      strong {
        font-weight: 600;
      }
      p { color: #52525b; margin: 20px 0; }
      a { display: inline-block; padding: 10px 20px; border-radius: 12px; background: #171717; color: #fff; text-decoration: none; }
      a:focus-visible { outline: 3px solid #52525b; outline-offset: 4px; }
      small { display: block; margin-top: 24px; color: #71717a; }
    </style>
  </head>
  <body>
    <main>
      ${
        maintenance
          ? `<h1>Temporarily unavailable</h1>
      <p>This service is undergoing maintenance. Please try again in a moment.</p>
      <a href="">Try again</a>
      <small>If you submitted a form, check whether it succeeded before submitting it again.</small>`
          : `<h1><strong>${escapeHtml(prefix)}</strong>${escapeHtml(title)}</h1>`
      }
    </main>
  </body>
</html>`;
}

export function createMaintenanceResponse(request: Request): Response {
  const headers = new Headers({ 'Cache-Control': 'no-store', 'Retry-After': '30' });
  if (!shouldServeHtmlErrorPage(request)) {
    return new Response(request.method === 'HEAD' ? null : 'Platform disabled', {
      status: 503,
      headers,
    });
  }
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(
    request.method === 'HEAD' ? null : renderDefaultErrorPage(503, 'Temporarily unavailable', true),
    {
      status: 503,
      headers,
    },
  );
}

export function shouldServeHtmlErrorPage(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return false;
  }

  const url = new URL(request.url);
  if (isApiPath(url.pathname)) {
    return false;
  }
  if (/\/[^/]+\.[^/]+$/.test(url.pathname)) {
    return false;
  }

  const destination = request.headers.get('sec-fetch-dest');
  if (destination && destination !== 'document' && destination !== 'empty') {
    return false;
  }

  const accept = request.headers.get('accept');
  return !accept || accept.includes('text/html') || accept.includes('*/*');
}

export function createErrorResponse(
  request: Request,
  status: number,
  title: string,
  headers?: HeadersInit,
): Response {
  if (!shouldServeHtmlErrorPage(request)) {
    return new Response(title, { status, headers });
  }

  const responseHeaders = new Headers(headers);
  responseHeaders.set('content-type', 'text/html; charset=utf-8');
  return new Response(request.method === 'HEAD' ? null : renderDefaultErrorPage(status, title), {
    status,
    headers: responseHeaders,
  });
}
