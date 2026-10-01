import { stripVTControlCharacters } from 'node:util';
import { expect, it, vi } from 'vite-plus/test';
import {
  cloudflareDeviceCode,
  cloudflareVerificationUrl,
  printCloudflareLoginPrompt,
} from '../../src/cli/cloudflare-login-output.ts';
import { encodeCloudflareOperation } from '../../src/cli/cloudflare-process.ts';

it('extracts the device code from cf output, including streamed and colored output', () => {
  expect(cloudflareDeviceCode('and enter the code:\n\n  a1B2c3D4\n')).toBe('a1B2c3D4');
  expect(cloudflareDeviceCode('and enter the code:\n')).toBeNull();
  expect(cloudflareDeviceCode('and enter the code:\n  \u001b[34ma1B2c3D4\u001b[0m\n')).toBe(
    'a1B2c3D4',
  );
  expect(
    cloudflareDeviceCode(
      'Opening a link in your default browser: https://dash.cloudflare.com/oauth2/device/verify?user_code=a1B2c3D4\n',
    ),
  ).toBe('a1B2c3D4');
});

it('extracts only the complete verification URL supplied by cf', () => {
  const url = 'https://dash.cloudflare.com/oauth2/device/verify?user_code=a1B2c3D4';
  expect(cloudflareVerificationUrl(`Opening a link in your default browser: ${url}\n`)).toBe(url);
  expect(cloudflareVerificationUrl(`To authorize cf, please visit:\n\n  ${url}\n`)).toBe(url);
  expect(
    cloudflareVerificationUrl(`Visit this link to authenticate: \u001b[34m${url}\u001b[0m\n`),
  ).toBe(url);
  expect(
    cloudflareVerificationUrl('Opening a link in your default browser: https://dash.cloud'),
  ).toBeNull();
  expect(cloudflareVerificationUrl('and enter the code:\n  a1B2c3D4\n')).toBeNull();
});

it('prints only the short Void prompt with the actual code', () => {
  const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    printCloudflareLoginPrompt('a1B2c3D4');
    expect(printed).toHaveBeenCalledTimes(1);
    expect(stripVTControlCharacters(printed.mock.calls[0]?.[0] ?? '')).toContain(
      'Opening Cloudflare login in your browser. Confirm the code a1B2c3D4 in your browser. Press Ctrl+C to cancel.',
    );
  } finally {
    printed.mockRestore();
  }
});

it('hides cf login chatter and prints the code before the child exits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'void-login-output-'));
  try {
    const preload = join(directory, 'mock-login.mjs');
    writeFileSync(
      preload,
      `import child from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
child.spawn = () => {
  const process = new EventEmitter();
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  setImmediate(() => {
    process.stderr.emit('data', Buffer.from('Attempting to login via OAuth Device Authorization Grant...\\nand enter the code:\\n  a1B2'));
    process.stderr.emit('data', Buffer.from('c3D4\\nOpening a link in your default browser: https://dash.cloudflare.com/oauth2/device/verify?user_code=a1B2'));
    process.stderr.emit('data', Buffer.from('c3D4\\nSuccessfully logged in.\\nConfig file: sample\\n'));
    process.emit('close', 0, null);
  });
  return process;
};
syncBuiltinESMExports();
`,
    );
    const entry = join(
      import.meta.dirname,
      '..',
      '..',
      'src',
      'cli',
      'cloudflare-operation-process.ts',
    );
    const output = await new Promise<{ status: number; stdout: string; stderr: string }>(
      (resolve) => {
        execFile(
          process.execPath,
          [
            '--import',
            pathToFileURL(preload).href,
            entry,
            ...encodeCloudflareOperation({ type: 'auth.login' }),
          ],
          {
            cwd: directory,
            encoding: 'utf8',
            timeout: 10_000,
            env: {
              ...process.env,
              CLOUDFLARE_AUTH_USE_KEYRING: 'false',
              HOME: directory,
              USERPROFILE: directory,
              XDG_CONFIG_HOME: join(directory, '.config'),
              APPDATA: join(directory, 'AppData', 'Roaming'),
              LOCALAPPDATA: join(directory, 'AppData', 'Local'),
            },
          },
          (error, stdout, stderr) => resolve({ status: error ? 1 : 0, stdout, stderr }),
        );
      },
    );
    expect(output.status, output.stderr).toBe(0);
    expect(stripVTControlCharacters(output.stdout.trim())).toBe(
      'Opening Cloudflare login in your browser. Confirm the code a1B2c3D4 in your browser. Press Ctrl+C to cancel.\nOpen this link if your browser did not open: https://dash.cloudflare.com/oauth2/device/verify?user_code=a1B2c3D4',
    );
    expect(output.stdout + output.stderr).not.toContain('Attempting to login');
    expect(output.stdout + output.stderr).not.toContain('Config file:');
    expect(output.stdout + output.stderr).not.toContain('Successfully logged in.');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
