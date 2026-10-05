import type { CloudflareTriggerConfig } from '@void/deploy-cloudflare';
import { expect, it } from 'vite-plus/test';
import { platformWorkerLiveTriggersMatch } from '../../src/cli/platform-trigger-proof.ts';

const desired: CloudflareTriggerConfig = {
  workers_dev: true,
  preview_urls: false,
  routes: [],
  crons: ['0 * * * *'],
  queueConsumers: [
    { queue: 'usage', max_batch_size: 100, max_batch_timeout: 5 },
    { queue: 'cron', max_batch_size: 50, max_batch_timeout: 1, max_retries: 3 },
  ],
  workflows: [],
};

function liveProof(
  overrides: {
    cron?: string;
    queues?: Array<unknown>;
    consumerBatchSize?: number;
    consumerConcurrency?: number;
    consumerWorker?: string;
    deadLetterQueue?: string;
    preview?: boolean;
    workflow?: Array<unknown>;
    failRead?: string;
  } = {},
) {
  const paths: Array<string> = [];
  const readCloudflare = async (path: string): Promise<unknown> => {
    paths.push(path);
    if (overrides.failRead && path.includes(overrides.failRead)) {
      throw new Error('read failed');
    }
    if (path.endsWith('/workers/workers/test-worker')) {
      return {
        name: 'test-worker',
        subdomain: { enabled: true, previews_enabled: overrides.preview ?? false },
        references: {
          queues: overrides.queues ?? [
            { queue_id: 'usage-id', queue_consumer_id: 'usage-consumer', queue_name: 'usage' },
            { queue_id: 'cron-id', queue_consumer_id: 'cron-consumer', queue_name: 'cron' },
          ],
        },
      };
    }
    if (path.endsWith('/schedules')) {
      return { schedules: [{ cron: overrides.cron ?? '0 * * * *' }] };
    }
    if (path.includes('/workflows?')) {
      return path.includes('page=2') ? [] : (overrides.workflow ?? []);
    }
    if (path.includes('/queues/')) {
      const usage = path.includes('/usage-id/');
      return {
        type: 'worker',
        ...(overrides.consumerWorker ? { script_name: overrides.consumerWorker } : {}),
        queue_name: usage ? 'usage' : 'cron',
        ...(overrides.deadLetterQueue ? { dead_letter_queue: overrides.deadLetterQueue } : {}),
        settings: {
          batch_size: usage ? (overrides.consumerBatchSize ?? 100) : 50,
          max_wait_time_ms: usage ? 5000 : 1000,
          max_retries: 3,
          ...(overrides.consumerConcurrency
            ? { max_concurrency: overrides.consumerConcurrency }
            : {}),
          retry_delay: 0,
        },
      };
    }
    throw new Error(`Unexpected read: ${path}`);
  };
  return { paths, readCloudflare };
}

it('proves matching live subdomain, cron, queue consumer, and workflow state', async () => {
  const live = liveProof();
  expect(
    await platformWorkerLiveTriggersMatch({
      accountId: 'account',
      workerName: 'test-worker',
      desired,
      readCloudflare: live.readCloudflare,
    }),
  ).toBe(true);
  expect(live.paths.filter((path) => path.includes('/queues/'))).toHaveLength(2);
});

it.each([
  { cron: '1 * * * *' },
  { consumerBatchSize: 99 },
  { consumerConcurrency: 2 },
  { consumerWorker: 'different-worker' },
  { deadLetterQueue: 'other-queue' },
  { preview: true },
  { workflow: [{ name: 'unexpected', script_name: 'test-worker' }] },
  { queues: [] },
  { failRead: '/workflows?' },
])(
  'requires normal trigger publication when live state drifts or cannot be read: %j',
  async (overrides) => {
    expect(
      await platformWorkerLiveTriggersMatch({
        accountId: 'account',
        workerName: 'test-worker',
        desired,
        readCloudflare: liveProof(overrides).readCloudflare,
      }),
    ).toBe(false);
  },
);

it('requires trigger publication to disable a workers.dev subdomain that is still enabled', async () => {
  expect(
    await platformWorkerLiveTriggersMatch({
      accountId: 'account',
      workerName: 'test-worker',
      desired: { ...desired, workers_dev: false },
      readCloudflare: liveProof().readCloudflare,
    }),
  ).toBe(false);
});

it('requires normal trigger publication for unsupported Email Routing and Workflow triggers', async () => {
  const live = liveProof();
  expect(
    await platformWorkerLiveTriggersMatch({
      accountId: 'account',
      workerName: 'test-worker',
      desired: { ...desired, addresses: [] },
      readCloudflare: live.readCloudflare,
    }),
  ).toBe(false);
  expect(live.paths).toHaveLength(0);
});
