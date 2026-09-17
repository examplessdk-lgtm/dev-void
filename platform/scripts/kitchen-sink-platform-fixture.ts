import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedPlayground } from '../../test/integration-helpers.ts';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));

/** The hosted smoke app exercises enabled platform features during the managed Sandbox pause. */
export function prepareKitchenSinkPlatformFixture() {
  const fixture = createIsolatedPlayground(workspaceRoot, 'playground/kitchen-sink');
  try {
    for (const path of [
      'routes/api/sandbox.ts',
      'pages/sandbox.vue',
      'pages/sandbox.server.ts',
      'lib/sandbox-demo.ts',
      '.env',
    ]) {
      rmSync(join(fixture.root, path), { force: true });
    }
    for (const [path, pattern] of [
      ['pages/layout.vue', /<Link href="\/sandbox">Sandbox<\/Link>\s*\|\s*/],
      ['pages/index.vue', /\s*<li><Link href="\/sandbox">Sandbox<\/Link>[^<]*<\/li>/],
    ] as const) {
      const file = join(fixture.root, path);
      const source = readFileSync(file, 'utf8');
      if (!pattern.test(source)) {
        throw new Error(`Update the hosted kitchen-sink fixture navigation for ${path}.`);
      }
      writeFileSync(file, source.replace(pattern, ''));
    }
    return fixture;
  } catch (error) {
    fixture.cleanup();
    throw error;
  }
}

if (import.meta.main) {
  const fixture = prepareKitchenSinkPlatformFixture();
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `path=${fixture.root}\n`);
  }
  console.log(`Prepared hosted kitchen-sink fixture: ${fixture.root}`);
}
