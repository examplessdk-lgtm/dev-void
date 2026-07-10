import { defineHandler } from 'void';

// ISR fixture: `export const revalidate` makes this page surface in the deploy
// manifest's `pages` table with its TTL. Exercised by the full-deploy manifest
// integration test (test/integration/full-deploy-manifest.test.ts).
export const revalidate = 60;

export const loader = defineHandler(() => {
  return {};
});
