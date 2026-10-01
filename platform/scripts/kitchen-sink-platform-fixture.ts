import { appendFileSync, cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedPlayground } from '../../test/integration-helpers.ts';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));

/** Provider-dependent features are opt-in for the disposable hosted acceptance app. */
export function prepareKitchenSinkPlatformFixture(
  options: { sandbox?: boolean; email?: boolean; runtime?: boolean } = {},
) {
  const fixture = createIsolatedPlayground(workspaceRoot, 'playground/kitchen-sink');
  try {
    rmSync(join(fixture.root, '.env'), { force: true });
    if (!options.sandbox) {
      for (const path of [
        'routes/api/sandbox.ts',
        'pages/sandbox.vue',
        'pages/sandbox.server.ts',
        'lib/sandbox-demo.ts',
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
    } else {
      cpSync(join(workspaceRoot, 'platform/scripts/fixtures/kitchen-sink-sandbox'), fixture.root, {
        recursive: true,
      });
    }
    if (options.email) {
      const source = join(workspaceRoot, 'platform/scripts/fixtures/kitchen-sink-email');
      cpSync(source, fixture.root, { recursive: true });
    }
    if (options.runtime) {
      cpSync(join(workspaceRoot, 'platform/scripts/fixtures/kitchen-sink-runtime'), fixture.root, {
        recursive: true,
      });
    }
    return fixture;
  } catch (error) {
    fixture.cleanup();
    throw error;
  }
}

if (import.meta.main) {
  const fixture = prepareKitchenSinkPlatformFixture({
    sandbox: process.argv.includes('--sandbox'),
    email: process.argv.includes('--email'),
    runtime: process.argv.includes('--runtime'),
  });
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `path=${fixture.root}\n`);
  }
  console.log(`Prepared hosted kitchen-sink fixture: ${fixture.root}`);
}
