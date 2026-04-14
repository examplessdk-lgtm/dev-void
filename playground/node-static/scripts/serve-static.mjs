import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, isAbsolute, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../dist/client');
const port = Number(process.env.PORT || 4179);

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function resolveStaticFile(requestUrl) {
  const { pathname } = new URL(requestUrl, 'http://localhost');
  const path = decodeURIComponent(pathname);
  const candidates =
    path === '/'
      ? ['index.html']
      : [path.slice(1), `${path.slice(1)}.html`, `${path.slice(1)}/index.html`];

  for (const candidate of candidates) {
    const filePath = resolve(root, candidate);
    const relativePath = relative(root, filePath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      continue;
    }
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      return filePath;
    }
  }
  return null;
}

createServer((request, response) => {
  const filePath = resolveStaticFile(request.url || '/');

  if (!filePath) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
    return;
  }

  response.writeHead(200, {
    'content-type': contentTypes[extname(filePath)] || 'application/octet-stream',
  });
  response.end(readFileSync(filePath));
}).listen(port, '127.0.0.1', () => {
  console.log(`Static playground: http://127.0.0.1:${port}`);
});
