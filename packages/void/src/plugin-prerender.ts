import { join } from "node:path";
import type { Plugin } from "vite";
import { isNodeTarget, type VoidConfig } from "./config";
import { resolveDistDir, resolveWorkerDirName } from "./cli/deploy";
import { collectPrerenderPaths } from "./prerender-paths";
import { prerenderPages, prerenderPagesNode } from "./prerender";
import { voidLog, voidWarn, setShowTimestamp } from "./log";

/**
 * Vite plugin that prerenders pages at build time when `output: "static"`.
 *
 * Runs in the `closeBundle` hook so prerender logs appear after Vite's
 * asset summary. Gated on the "client" environment so it only runs once.
 */
export function prerenderPlugin(root: string, config: VoidConfig): Plugin {
  return {
    name: "void:prerender",
    apply: "build",

    async closeBundle() {
      if (config.output !== "static") return;
      if (this.environment?.name !== "client") return;
      setShowTimestamp(false);

      // Prerender only applies to void apps (not meta-frameworks), so no preset needed
      const distDir = resolveDistDir(root);
      const clientDir = join(distDir, "client");

      // Collect paths to prerender
      const paths = await collectPrerenderPaths({ root, config });
      if (paths.length === 0) {
        voidLog("No pages to prerender");
        return;
      }

      voidLog(`Prerendering ${paths.length} page(s)...`);

      let result;

      if (isNodeTarget(config.target)) {
        // Node/Bun/Deno: run prerender in a child process
        result = await prerenderPagesNode({
          root,
          ssrDir: join(distDir, "ssr"),
          clientDir,
          paths,
        });
      } else {
        // Cloudflare: use Miniflare
        const persistDir = join(root, ".void");
        const workerDirName = resolveWorkerDirName(distDir);
        const workerDir = join(distDir, workerDirName);

        result = await prerenderPages({
          root,
          workerDir,
          clientDir,
          paths,
          persistDir,
        });
      }

      if (result.failed.length > 0) {
        voidWarn(`${result.failed.length} page(s) failed to prerender`);
      }
    },
  };
}
