import { cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path/posix';
import type { TestProject } from 'vite-plus/test/node';
import { shouldCopyPlaygroundPath } from './integration-helpers.ts';

/** Capture sources before HMR tests edit them and other files clone their fixtures. */
export default function setup(project: TestProject): () => void {
  const snapshots = project.config.env.VOID_TEST_SOURCE_SNAPSHOTS;
  if (!snapshots) {
    throw new Error('Missing integration source snapshot directory.');
  }
  try {
    for (const name of ['react-pages', 'vue-pages', 'svelte-pages', 'solid-pages']) {
      const source = join(project.config.root.replaceAll('\\', '/'), 'playground', name);
      if (existsSync(source)) {
        cpSync(source, join(snapshots, 'playground', name), {
          recursive: true,
          filter: (path) => shouldCopyPlaygroundPath(source, path),
        });
      }
    }
  } catch (error) {
    rmSync(snapshots, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    throw error;
  }
  return () => rmSync(snapshots, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}
