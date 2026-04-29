import { join } from 'node:path';
import type { Plugin } from 'vite';
import { resolveDistDir, resolveWorkerDirName } from './cli/deploy.ts';
import { isNodeTarget, type VoidConfig } from './config.ts';
import { voidLog, voidWarn, setShowTimestamp } from './log.ts';
import { prerenderPages, prerenderPagesNode } from './prerender.ts';
import { resolveRemoteMode } from './shared/env.ts';

/**
 * Vite plugin that prerenders pages at build time when `output: "static"`.
 *
 * Runs in the `closeBundle` hook so prerender logs appear after Vite's
 * asset summary. Gated on the "client" environment so it only runs once.
 */
export function prerenderPlugin(root: string, config: VoidConfig): Plugin {
  return {
    name: 'void:prerender',
    apply: 'build',

    async closeBundle() {
      if (config.output !== 'static') {
        return;
      }
      if (this.environment?.name !== 'client') {
        return;
      }
      setShowTimestamp(false);

      // Prerender only applies to void apps (not meta-frameworks), so no preset needed
      const distDir = resolveDistDir(root);
      const clientDir = join(distDir, 'client');

      let result;

      if (isNodeTarget(config.target)) {
        result = await prerenderPagesNode({
          root,
          ssrDir: join(distDir, 'ssr'),
          clientDir,
        });
      } else {
        const persistDir = join(root, '.void');
        const workerDirName = resolveWorkerDirName(distDir);
        const workerDir = join(distDir, workerDirName);
        const remoteMode = resolveRemoteMode(config.remote);

        result = await prerenderPages({
          root,
          workerDir,
          clientDir,
          persistDir,
          remoteMode,
          // closeBundle runs inside the vite build subprocess, so the parent
          // deploy process's in-memory projectId only crosses via env var.
          projectId: process.env.VOID_DEPLOY_PROJECT_ID || undefined,
        });
      }

      if (result.paths.length === 0) {
        voidLog('No pages to prerender');
        return;
      }

      if (result.failed.length > 0) {
        voidWarn(`${result.failed.length} page(s) failed to prerender`);
      }
    },
  };
}
