import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { createIsolatedPlayground } from '../../../../test/integration-helpers.ts';

let root: string;
afterEach(() => {
  vi.unstubAllEnvs();
  if (root) {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

it('clones stable source snapshots while resolving dependencies from the actual workspace', () => {
  root = mkdtempSync(join(tmpdir(), 'void-snapshot-test-'));
  const source = join(root, 'playground/react-pages');
  const snapshot = join(root, 'snapshots/playground/react-pages');
  mkdirSync(join(source, 'node_modules'), { recursive: true });
  mkdirSync(snapshot, { recursive: true });
  for (const path of [source, snapshot]) {
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name: 'test-app' }));
  }
  writeFileSync(join(source, 'page.ts'), 'temporary HMR mutation');
  writeFileSync(join(snapshot, 'page.ts'), 'original source');
  vi.stubEnv('VOID_TEST_SOURCE_SNAPSHOTS', join(root, 'snapshots'));

  const fixture = createIsolatedPlayground(root, 'playground/react-pages');
  expect(readFileSync(join(fixture.root, 'page.ts'), 'utf8')).toBe('original source');
  expect(realpathSync(join(fixture.root, 'node_modules'))).toBe(
    realpathSync(join(source, 'node_modules')),
  );
  expect(readFileSync(join(source, 'page.ts'), 'utf8')).toBe('temporary HMR mutation');
  fixture.cleanup();
});

it('uses current source outside the integration snapshot lifecycle', () => {
  root = mkdtempSync(join(tmpdir(), 'void-snapshot-test-'));
  const source = join(root, 'playground/test');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'test-app' }));
  writeFileSync(join(source, 'page.ts'), 'current source');
  vi.stubEnv('VOID_TEST_SOURCE_SNAPSHOTS', undefined);
  const fixture = createIsolatedPlayground(root, 'playground/test');
  expect(readFileSync(join(fixture.root, 'page.ts'), 'utf8')).toBe('current source');
  fixture.cleanup();
});
