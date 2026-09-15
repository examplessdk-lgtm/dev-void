import { describe, expect, it } from 'vite-plus/test';
import { formatCloudflareUserMessage } from '../../src/cli/cloudflare-user-output.ts';

describe('Cloudflare user output', () => {
  it('keeps real config names and environment variables recognizable', () => {
    expect(
      formatCloudflareUserMessage(
        'Fix /app/wrangler.jsonc and unset WRANGLER_CI_OVERRIDE_NAME or CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH.',
      ),
    ).toBe(
      'Fix /app/wrangler.jsonc and unset WRANGLER_CI_OVERRIDE_NAME or CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH.',
    );
  });

  it('maps actionable commands to Void and hides implementation details', () => {
    expect(
      formatCloudflareUserMessage(
        'Wrangler failed. Run `wrangler secret list`, then `wrangler deploy`. The wrangler uploader changed.',
      ),
    ).toBe(
      'Cloudflare tooling failed. Run `void secret list`, then `void deploy --platform cloudflare`. The Cloudflare deployment tool changed.',
    );
  });

  it('turns unsupported low-level commands into Cloudflare operations', () => {
    expect(formatCloudflareUserMessage('Refusing to run `wrangler queues info example`.')).toBe(
      'Refusing to run the underlying Cloudflare operation.',
    );
  });
});
