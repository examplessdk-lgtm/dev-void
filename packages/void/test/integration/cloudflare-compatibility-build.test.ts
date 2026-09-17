import { readFileSync, writeFileSync } from 'node:fs';
import spawn from 'cross-spawn';
import { join } from 'pathslash';
import { describe, expect, it } from 'vite-plus/test';
import { createIsolatedPlayground } from '../../../../test/integration-helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

describe('Cloudflare compatibility flags in real builds', () => {
  it.each([
    { rootFlags: ['nodejs_als'], voidFlags: undefined, expected: ['nodejs_als'] },
    { rootFlags: ['nodejs_compat'], voidFlags: ['nodejs_compat'], expected: ['nodejs_compat'] },
    { rootFlags: ['nodejs_als', 'nodejs_als'], voidFlags: undefined, expected: ['nodejs_als'] },
    {
      rootFlags: ['nodejs_als', 'global_fetch_strictly_public'],
      voidFlags: ['nodejs_als', 'url_standard'],
      expected: ['nodejs_als', 'url_standard', 'global_fetch_strictly_public'],
    },
  ])('emits each flag once for %j', ({ rootFlags, voidFlags, expected }) => {
    const playground = createIsolatedPlayground(ROOT, 'playground/ssr');
    try {
      const configPath = join(playground.root, 'wrangler.jsonc');
      const rootConfig = JSON.stringify({
        name: 'compatibility-test',
        compatibility_date: '2026-02-24',
        compatibility_flags: rootFlags,
      });
      writeFileSync(configPath, rootConfig);
      if (voidFlags) {
        const voidPath = join(playground.root, 'void.json');
        const config = JSON.parse(readFileSync(voidPath, 'utf8'));
        config.worker.compatibility_flags = voidFlags;
        writeFileSync(voidPath, JSON.stringify(config));
      }

      const result = spawn.sync(
        'vp',
        ['run', '--filter', `./${playground.workspacePath}`, 'build'],
        {
          cwd: ROOT,
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      expect(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`).toBe(0);

      const generated = JSON.parse(
        readFileSync(join(playground.root, 'dist/ssr/wrangler.json'), 'utf8'),
      );
      expect(generated.compatibility_flags).toEqual(expected);
      expect(readFileSync(configPath, 'utf8')).toBe(rootConfig);
    } finally {
      playground.cleanup();
    }
  });
});
