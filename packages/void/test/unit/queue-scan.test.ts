import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { scanQueuesSync } from '../../src/queues/scan.ts';

describe('scanQueuesSync', () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `queue-scan-test-${Date.now()}`);
    mkdirSync(join(root, 'queues'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('extracts maxRetries and retryDelay from queue file', () => {
    writeFileSync(
      join(root, 'queues', 'emails.ts'),
      `import { defineQueue } from "void";
export const maxRetries = 5;
export const retryDelay = 30;
export default defineQueue(async (batch, env) => {});`,
    );

    const queues = scanQueuesSync(root);
    expect(queues).toHaveLength(1);
    expect(queues[0].maxRetries).toBe(5);
    expect(queues[0].retryDelay).toBe(30);
  });

  it('returns undefined for missing consumer options', () => {
    writeFileSync(
      join(root, 'queues', 'basic.ts'),
      `import { defineQueue } from "void";
export default defineQueue(async (batch, env) => {});`,
    );

    const queues = scanQueuesSync(root);
    expect(queues).toHaveLength(1);
    expect(queues[0].maxRetries).toBeUndefined();
    expect(queues[0].retryDelay).toBeUndefined();
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

    const queues = scanQueuesSync(root);
    expect(queues).toHaveLength(1);
    expect(queues[0].maxBatchSize).toBe(50);
    expect(queues[0].maxBatchTimeout).toBe(10);
    expect(queues[0].maxRetries).toBe(3);
    expect(queues[0].retryDelay).toBe(60);
  });
});
