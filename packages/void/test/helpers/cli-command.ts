import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vite-plus/test';
import { Buffer } from '../../src/cli/node-buffer.ts';
import { savePlatformConnection } from '../../src/cli/platform-registry.ts';

/** Collects stdout writes and `console.log` lines until `restore()` is called. */
export function captureOutput(): { output: () => string; restore: () => void } {
  const chunks: Array<string> = [];
  const writeMock = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((...args: Array<unknown>) => {
      const chunk = args[0];
      if (typeof chunk === 'string') {
        chunks.push(chunk);
      } else if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk.toString());
      }
      return true;
    });
  const logMock = vi.spyOn(console, 'log').mockImplementation((...args: Array<unknown>) => {
    chunks.push(args.map(String).join(' ') + '\n');
  });
  return {
    output: () => chunks.join(''),
    restore: () => {
      writeMock.mockRestore();
      logMock.mockRestore();
    },
  };
}

/**
 * Points HOME and the platform registry at a new temp directory that holds one
 * connected platform. Returns the directory so the caller can remove it.
 */
export function setIsolatedHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'void-home-'));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.VOID_PLATFORM_REGISTRY_DIR = join(dir, 'registry');
  savePlatformConnection({
    accountId: null,
    apiUrl: 'https://api.example.test',
    applicationDomain: 'apps.example.test',
    displayName: 'Test platform',
    installationId: null,
    kind: 'connected',
    proxyUrl: 'https://proxy.example.test',
  });
  return dir;
}
