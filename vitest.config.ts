import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

const maxWorkers = process.env.CI ? 2 : Math.max(2, Math.floor(availableParallelism() * 0.75));

// Windows CI runners are 2–3× slower for builds and server startup.
const ciTimeoutScale = process.platform === 'win32' ? 3 : 1;
const testTimeout = 120_000 * ciTimeoutScale;
const hookTimeout = 120_000 * ciTimeoutScale;

const metaframeworks = [
  'packages/void/test/integration/analog.test.ts',
  'packages/void/test/integration/astro.test.ts',
  'packages/void/test/integration/nuxt.test.ts',
  'packages/void/test/integration/sveltekit.test.ts',
  'packages/void/test/integration/tanstack-start.test.ts',
  'packages/void/test/integration/vinext-pages.test.ts',
  'packages/void/test/integration/vinext-app.test.ts',
  'packages/void/test/integration/react-router.test.ts',
];

export default defineConfig({
  test: {
    silent: 'passed-only',
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/unit/**/*.test.ts'],
          sequence: { groupOrder: 1 },
        },
      },
      {
        test: {
          name: 'core-markdown',
          sequence: { groupOrder: 3 },
          testTimeout,
          hookTimeout,
          include: [
            'packages/void/test/integration/**/*.test.ts',
            'packages/md/test/integration/**/*.test.ts',
          ],
          exclude: metaframeworks,
          maxWorkers,
          // kitchen-sink.test.ts (dev server) and kitchen-sink-build.test.ts
          // (build) both use playground/kitchen-sink/. The build test deletes
          // .void/ before running, which destroys miniflare persistence that
          // the dev server depends on. Serialize to prevent the conflict.
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'metaframeworks',
          sequence: { groupOrder: 2 },
          include: metaframeworks,
          maxWorkers,
          testTimeout,
          hookTimeout,
        },
      },
      {
        test: {
          name: 'pages-react-vue',
          sequence: { groupOrder: 2 },
          include: [
            'packages/react/test/integration/**/*.test.ts',
            'packages/vue/test/integration/**/*.test.ts',
          ],
          maxWorkers,
          testTimeout,
          hookTimeout,
        },
      },
      {
        test: {
          name: 'pages-svelte-solid',
          sequence: { groupOrder: 2 },
          include: [
            'packages/svelte/test/integration/**/*.test.ts',
            'packages/solid/test/integration/**/*.test.ts',
          ],
          maxWorkers,
          testTimeout,
          hookTimeout,
        },
      },
    ],
  },
});
