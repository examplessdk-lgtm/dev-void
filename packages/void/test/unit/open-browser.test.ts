import type { execFile } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { openBrowser } from '../../src/cli/auth.ts';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => Object.defineProperty(process, 'platform', platform));

it('passes prefilled setup URLs intact to Windows without command-shell interpretation', () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
  const run = vi.fn();
  const url =
    'https://dash.cloudflare.com/?to=%2Faccount%2Fapi-tokens&name=Void%20Runtime&permissionGroupKeys=%5B%5D';
  openBrowser(url, run as unknown as typeof execFile);
  expect(run).toHaveBeenCalledWith(
    'rundll32.exe',
    ['url.dll,FileProtocolHandler', url],
    expect.any(Function),
  );
});
