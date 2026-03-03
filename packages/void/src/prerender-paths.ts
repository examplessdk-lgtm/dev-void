import { existsSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "vite";
import { scanPages } from "./pages/scan";
import { detectSsrPrerender, getSsrServerEntryPath } from "./ssr/entry";
import type { VoidConfig } from "./config";

/**
 * Collect all paths that should be prerendered.
 *
 * Sources (same as deploy.ts logic):
 * 1. Static pages from scanPages() where prerender=true + no params
 * 2. Dynamic pages via createServer() + ssrLoadModule() + getPrerenderPaths()
 * 3. Custom SSR via detectSsrPrerender() + getPrerenderPaths()
 * 4. Explicit paths from config.cache.prerender
 * 5. Deduplicate
 */
export async function collectPrerenderPaths(options: {
  root: string;
  config: VoidConfig;
}): Promise<string[]> {
  const { root, config } = options;
  const prerenderPaths: string[] = [];

  const pageScan = existsSync(join(root, "pages"))
    ? await scanPages(root, { output: config.output })
    : null;

  if (pageScan) {
    // Static pages: no params, prerender = true
    for (const page of pageScan.pages) {
      if (page.prerender && page.params.length === 0 && !page.catchAll) {
        prerenderPaths.push(page.pattern);
      }
    }

    // Dynamic pages: prerender = true + getPrerenderPaths
    const dynamicPrerenderPages = pageScan.pages.filter(
      (p) => p.prerender && p.hasGetPrerenderPaths && (p.params.length > 0 || p.catchAll),
    );
    if (dynamicPrerenderPages.length > 0) {
      const viteServer = await createServer({
        root,
        configFile: false,
        server: { middlewareMode: true },
        logLevel: "silent",
      });
      try {
        for (const page of dynamicPrerenderPages) {
          try {
            const serverFile = page.serverPath
              ? join(root, "pages", page.serverPath)
              : join(root, "pages", page.componentPath);
            const mod = await viteServer.ssrLoadModule(serverFile);
            if (typeof mod.getPrerenderPaths === "function") {
              const paramSets = await mod.getPrerenderPaths();
              if (Array.isArray(paramSets)) {
                for (const params of paramSets) {
                  let path = page.pattern;
                  for (const [key, value] of Object.entries(params as Record<string, string>)) {
                    path = path.replace(`:${key}`, value);
                  }
                  prerenderPaths.push(path);
                }
              }
            }
          } catch (err) {
            throw new Error(
              `Failed to resolve prerender paths for ${page.pattern}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } finally {
        await viteServer.close();
      }
    }
  }

  // Custom SSR: getPrerenderPaths() in src/main.ssr.ts
  const ssrPrerender = detectSsrPrerender(root);
  if (ssrPrerender?.hasGetPrerenderPaths) {
    const viteServer = await createServer({
      root,
      configFile: false,
      server: { middlewareMode: true },
      logLevel: "silent",
    });
    try {
      const entryPath = getSsrServerEntryPath(root)!;
      const mod = await viteServer.ssrLoadModule(entryPath);
      if (typeof mod.getPrerenderPaths === "function") {
        const paths = await mod.getPrerenderPaths();
        if (Array.isArray(paths)) {
          for (const p of paths) {
            if (typeof p === "string") prerenderPaths.push(p);
          }
        }
      }
    } catch (err) {
      throw new Error(
        `Failed to resolve SSR prerender paths: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      await viteServer.close();
    }
  }

  // Add explicit prerender paths from void.json cache.prerender
  if (config.cache?.prerender) {
    prerenderPaths.push(...config.cache.prerender);
  }

  // Dedupe
  return [...new Set(prerenderPaths)];
}
