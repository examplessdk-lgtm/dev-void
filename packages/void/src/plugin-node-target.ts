import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { dirname, join, relative } from 'pathslash';
import type { Plugin } from 'vite';
import { readProjectPaths } from './project-paths.ts';

/** Imports that require CF bindings and are not available in Node.js mode. */
export const CF_ONLY_IMPORTS: Array<string> = [
  'void/db',
  'void/kv',
  'void/auth',
  'void/storage',
  'void/ai',
  'void/sandbox',
  'void/env',
];

const CF_ONLY_REGEX = new RegExp(
  `^(${CF_ONLY_IMPORTS.map((s) => s.replace('/', '\\/')).join('|')})$`,
);

type NodeTarget = 'node' | 'bun' | 'deno';

/**
 * Bridge Node.js HTTP to Web API and serve via a Hono app.
 * Used by both dev server and preview server middleware.
 */
function honoMiddleware(
  getApp: () => Promise<{ fetch: (req: Request) => Promise<Response> } | null>,
) {
  return async (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
    try {
      // Let Vite handle its own internal requests (HMR, modules, etc.)
      if (
        !req.url ||
        req.url.startsWith('/@') ||
        req.url.startsWith('/__') ||
        req.url.startsWith('/node_modules/')
      ) {
        next();
        return;
      }

      const app = await getApp();
      if (!app?.fetch) {
        next();
        return;
      }

      // Build a Request from the incoming Node.js http.IncomingMessage
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value) {
          headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
      }

      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const request = new Request(url.toString(), {
        method: req.method,
        headers,
        body: hasBody ? (req as unknown as BodyInit) : undefined,
        // @ts-ignore Node.js specific
        duplex: hasBody ? 'half' : undefined,
      });

      const response = await app.fetch(request);

      // If Hono returned 404 (no matching route), fall through to Vite
      // so static assets and dev-time resources are served normally.
      if (response.status === 404) {
        next();
        return;
      }

      // Write the Response back to Node.js http.ServerResponse
      res.statusCode = response.status;
      response.headers.forEach((value: string, key: string) => {
        res.setHeader(key, value);
      });

      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          res.write(value);
        }
        res.end();
      } else {
        res.end();
      }
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Vite plugin for non-Cloudflare deploy targets (Node.js, Bun, Deno).
 *
 * Replaces `@cloudflare/vite-plugin` in the plugin composition. Provides:
 * 1. Binding guard — compile-time errors for CF-only void/* imports
 * 2. Dev server — Vite SSR middleware to run Hono in Node.js
 * 3. Preview server — serves from the built SSR entry
 * 4. Build — dual-environment build (client + SSR) for pages apps,
 *    single SSR build for API-only apps
 */
export function nodeTargetPlugin(target: NodeTarget): Array<Plugin> {
  const guardPlugin: Plugin = {
    name: 'void:node-target',
    enforce: 'pre',

    resolveId: {
      filter: { id: CF_ONLY_REGEX },
      handler(id) {
        throw new Error(
          `target: '${id}' is not available with target '${target}'. ` +
            `CF bindings require target: "cloudflare".`,
        );
      },
    },

    renderChunk(code, chunk) {
      if (!code.includes('import.meta.voidClientDirectory')) {
        return null;
      }
      // app.js may re-export a shared module under assets/. Compute from the
      // actual emitted chunk rather than the source entry or process cwd.
      const clientPath = relative(dirname(chunk.fileName), '../client');
      return {
        code: code.replaceAll(
          'import.meta.voidClientDirectory',
          `new URL(${JSON.stringify(`${clientPath}/`)}, import.meta.url)`,
        ),
        map: null,
      };
    },

    config(_, { command }) {
      if (command !== 'build') {
        // The dev server (and Vitest) run routes in Vite's Node SSR graph, which
        // externalizes a bare import resolving into node_modules before any plugin sees
        // it. An installed void/kv would then skip the guard above. Inlining void keeps
        // every void import on the plugin path, as with a workspace link.
        return { ssr: { noExternal: ['void'] } };
      }

      const root = process.cwd();
      const voidDir = join(root, '.void');
      const ssrBuildOptions = {
        outDir: 'dist/ssr',
        rollupOptions: {
          input: {
            app: join(voidDir, 'app.ts'),
            index: join(voidDir, 'index.ts'),
          },
          external: [/^node:/, '@hono/node-server', '@hono/node-server/serve-static'],
        },
      };

      // Pages apps need dual builds: client (React hydration) + SSR (server entry).
      // API-only apps need a single SSR build.
      if (existsSync(readProjectPaths(root).pagesDir)) {
        return {
          build: { outDir: 'dist/client' },
          environments: {
            ssr: { build: ssrBuildOptions },
          },
          // Opt into Vite's multi-environment builder (without this,
          // Vite uses the legacy single-environment builder).
          builder: {},
        };
      }

      return {
        build: {
          ssr: true,
          ...ssrBuildOptions,
        },
      };
    },

    // Orchestrate dual-environment build for pages apps.
    // For API-only apps (no `environments.ssr`), this hook is not triggered
    // because Vite's builder is only created when extra environments exist.
    async buildApp(builder) {
      // SSR must build first so that dist/ssr/app.js exists when the
      // prerender plugin runs in the client environment's closeBundle hook.
      await builder.build(builder.environments.ssr);
      await builder.build(builder.environments.client);
    },

    configureServer(server) {
      // Middleware runs BEFORE Vite's built-in middleware so API routes
      // and SSR pages are handled before Vite's SPA fallback sends a 404.
      // The honoMiddleware helper skips /@, /__, and /node_modules/ paths
      // so Vite's HMR and module serving still work normally.
      server.middlewares.use(
        honoMiddleware(async () => {
          const mod = await server.ssrLoadModule('virtual:void-routes');
          return mod.default;
        }),
      );
    },

    configurePreviewServer(server) {
      // Import the built app module (not index.js which starts a server).
      const entryPath = join(process.cwd(), 'dist', 'ssr', 'app.js');
      let appPromise: Promise<{ fetch: (req: Request) => Promise<Response> } | null> | null = null;

      server.middlewares.use(
        honoMiddleware(() => {
          if (!appPromise) {
            const entryUrl = pathToFileURL(entryPath).href;
            appPromise = import(/* @vite-ignore */ entryUrl).then(
              (m) => m.default,
              () => null,
            );
          }
          return appPromise;
        }),
      );
    },
  };

  return [guardPlugin];
}
