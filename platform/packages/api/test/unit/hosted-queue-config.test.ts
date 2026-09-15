import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

const wranglerConfig = readFileSync(resolve(import.meta.dirname, '../../wrangler.jsonc'), 'utf8');

describe('hosted queue configuration', () => {
  it('identifies cron batches in every hosted environment', () => {
    expect(wranglerConfig.match(/"CRON_FIRES_QUEUE_NAME": "void-cron-fires"/g)).toHaveLength(2);
    expect(
      wranglerConfig.match(/"CRON_FIRES_QUEUE_NAME": "void-cron-fires-staging"/g),
    ).toHaveLength(1);
  });
});
