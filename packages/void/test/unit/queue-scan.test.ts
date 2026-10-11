import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vite-plus/test';
import { scanQueuesSync } from '../../src/queues/scan.ts';

describe('scanQueuesSync', () => {
  let root: string;
  let queuesDir: string;

  beforeEach(() => {
    root = join(tmpdir(), `queue-scan-test-${Date.now()}`);
    queuesDir = join(root, 'queues');
    mkdirSync(queuesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('extracts all consumer options together', () => {
    writeFileSync(
      join(root, 'queues', 'full.ts'),
      `import { defineQueue } from "void";
export const maxBatchSize = 50;
export const maxBatchTimeout = 10;
export const maxRetries = 3;
export const retryDelay = 60;
export default defineQueue(async (batch, env) => {});`,
    );

    const queues = scanQueuesSync(queuesDir);
    expect(queues).toHaveLength(1);
    expect(queues[0].maxBatchSize).toBe(50);
    expect(queues[0].maxBatchTimeout).toBe(10);
    expect(queues[0].maxRetries).toBe(3);
    expect(queues[0].retryDelay).toBe(60);
  });

  it('ignores options mentioned only in comments and strings', () => {
    writeFileSync(
      join(root, 'queues', 'basic.ts'),
      `// export const maxBatchSize = 99;
const example = 'export const retryDelay = 50';
export const maxRetries = 3 as const;
export default async () => {};`,
    );
    expect(scanQueuesSync(queuesDir)).toMatchObject([
      { maxBatchSize: undefined, maxRetries: 3, retryDelay: undefined },
    ]);
  });

  it('rejects a nonliteral consumer option instead of reading a numeric prefix', () => {
    writeFileSync(
      join(root, 'queues', 'basic.ts'),
      'export const maxBatchSize = 2 + 3; export default async () => {};',
    );
    expect(() => scanQueuesSync(queuesDir)).toThrow('maxBatchSize');
  });

  it('normalizes nested paths while preserving binding derivation', () => {
    mkdirSync(join(root, 'queues', 'order'), { recursive: true });
    writeFileSync(
      join(root, 'queues', 'order', 'notifications.ts'),
      `export default async () => {};`,
    );

    expect(scanQueuesSync(queuesDir)).toEqual([
      {
        filePath: 'order/notifications.ts',
        name: 'order-notifications',
        bindingName: 'QUEUE_ORDER_NOTIFICATIONS',
      },
    ]);
  });

  it('reports normalized name collisions in deterministic path order', () => {
    mkdirSync(join(root, 'queues', 'order'), { recursive: true });
    writeFileSync(join(root, 'queues', 'order-notifications.ts'), 'export default {};');
    writeFileSync(join(root, 'queues', 'order', 'notifications.ts'), 'export default {};');

    expect(() => scanQueuesSync(queuesDir)).toThrow(
      [
        'queue: Multiple queue files resolve to the same queue name:',
        '  "order-notifications": "order-notifications.ts", "order/notifications.ts"',
        'Rename the conflicting files so each queue has a unique name.',
      ].join('\n'),
    );
  });
});
