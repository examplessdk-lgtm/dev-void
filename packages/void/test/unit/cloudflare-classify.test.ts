import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { classifyCloudflareDeployApp } from '../../src/cli/cloudflare-deploy/classify.ts';
import type { VoidConfig } from '../../src/config.ts';

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('classifyCloudflareDeployApp', () => {
  it('describes an unresolved static output without claiming static deploys are unsupported', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-cloudflare-classify-'));
    roots.push(root);

    const result = classifyCloudflareDeployApp(
      root,
      { inference: { appType: 'static' } } as VoidConfig,
      {},
    );

    expect(result).toEqual({
      supported: false,
      reason: [
        'deploy: --platform cloudflare could not resolve the static output to deploy.',
        'Set inference.outputDir in void.json, pass --dir with an existing build directory,',
        'or add a supported build tool so Void can locate the generated static assets.',
      ].join('\n'),
    });
  });
});
