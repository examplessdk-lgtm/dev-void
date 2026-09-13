import { describe, expect, it, vi } from 'vite-plus/test';
import { executeCloudflareDeploy } from '../../src/index.ts';

describe('executeCloudflareDeploy', () => {
  it('uploads the verified artifact with implicit provisioning disabled', async () => {
    const runWrangler = vi.fn(() => ({ stdout: '', stderr: '', status: 0 }));

    await expect(
      executeCloudflareDeploy({ runWrangler, verifyUploader: () => true }),
    ).resolves.toEqual({ ok: true });
    expect(runWrangler).toHaveBeenCalledWith(
      [
        'deploy',
        '--env=',
        '--experimental-provision=false',
        '--experimental-auto-create=false',
        '--autoconfig=false',
      ],
      { capture: false },
    );
  });

  it('does not invoke Wrangler when its uploader changed', async () => {
    const runWrangler = vi.fn(() => ({ stdout: '', stderr: '', status: 0 }));

    await expect(
      executeCloudflareDeploy({ runWrangler, verifyUploader: () => false }),
    ).resolves.toEqual({ ok: false, reason: 'uploader-changed' });
    expect(runWrangler).not.toHaveBeenCalled();
  });

  it('can pin an explicit generated config', async () => {
    const runWrangler = vi.fn(() => ({ stdout: '', stderr: '', status: 0 }));

    await executeCloudflareDeploy({
      runWrangler,
      verifyUploader: () => true,
      configPath: '/app/wrangler.jsonc',
    });

    expect(runWrangler).toHaveBeenCalledWith(
      [
        'deploy',
        '-c',
        '/app/wrangler.jsonc',
        '--env=',
        '--experimental-provision=false',
        '--experimental-auto-create=false',
        '--autoconfig=false',
      ],
      { capture: false },
    );
  });

  it('reports failed and interrupted Wrangler commands', async () => {
    const runWrangler = vi.fn(() => ({
      stdout: '',
      stderr: '',
      status: 0,
      signal: 'SIGTERM' as const,
    }));

    await expect(
      executeCloudflareDeploy({ runWrangler, verifyUploader: () => true }),
    ).resolves.toEqual({ ok: false, reason: 'deploy-failed', status: 0 });
  });
});
