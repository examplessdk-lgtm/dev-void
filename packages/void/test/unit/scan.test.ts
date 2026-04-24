import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { scanRoutes } from '../../src/router/scan';

const TMP = join(import.meta.dirname, '__tmp_scan_test__');

function createFile(path: string, content = 'export const GET = () => {}') {
  const full = join(TMP, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

describe('scanRoutes', () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('discovers route files with methods from exports', async () => {
    createFile('routes/api/hello.ts', 'export const GET = () => {}');
    createFile(
      'routes/api/users/index.ts',
      'export const GET = () => {}\nexport const POST = () => {}',
    );

    const result = await scanRoutes(TMP);
    expect(result.routes).toHaveLength(2);

    const hello = result.routes.find((r) => r.pattern === '/api/hello')!;
    expect(hello.methods).toEqual(['GET']);

    const users = result.routes.find((r) => r.pattern === '/api/users')!;
    expect(users.methods).toEqual(['GET', 'POST']);
    expect(result.jobs).toEqual([]);
  });

  it('ignores files starting with _', async () => {
    createFile('routes/api/hello.ts');
    createFile('routes/api/_utils.ts');

    const result = await scanRoutes(TMP);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].pattern).toBe('/api/hello');
  });

  it('discovers and sorts middleware by numeric prefix', async () => {
    createFile('middleware/02.auth.ts');
    createFile('middleware/01.logger.ts');

    const result = await scanRoutes(TMP);
    expect(result.middleware).toHaveLength(2);
    expect(result.middleware[0].order).toBe(1);
    expect(result.middleware[1].order).toBe(2);
    expect(result.jobs).toEqual([]);
  });

  it('handles missing middleware directory', async () => {
    createFile('routes/hello.ts');
    // No middleware/ directory

    const result = await scanRoutes(TMP);
    expect(result.middleware).toEqual([]);
    expect(result.routes).toHaveLength(1);
    expect(result.jobs).toEqual([]);
  });

  it('sorts catch-all routes last', async () => {
    createFile('routes/[...].ts', 'export const GET = () => {}');
    createFile('routes/api/hello.ts', 'export const GET = () => {}');

    const result = await scanRoutes(TMP);
    expect(result.routes[0].pattern).toBe('/api/hello');
    expect(result.routes[1].pattern).toBe('/*');
  });

  it('discovers cron jobs from crons directory', async () => {
    createFile('routes/api/hello.ts');
    createFile('crons/sync.ts', 'export const cron = "0 * * * *"\nexport default () => {}');
    createFile(
      'crons/reports/daily.mjs',
      'export const cron = "0 0 * * *"\nexport default async () => {}',
    );

    const result = await scanRoutes(TMP);
    expect(result.jobs).toEqual([
      { filePath: 'reports/daily.mjs', name: 'reports/daily', crons: ['0 0 * * *'] },
      { filePath: 'sync.ts', name: 'sync', crons: ['0 * * * *'] },
    ]);
  });

  it('discovers cron jobs with array cron syntax', async () => {
    createFile('routes/api/hello.ts');
    createFile(
      'crons/multi.ts',
      'export const cron = ["0 * * * *", "30 * * * *"]\nexport default () => {}',
    );

    const result = await scanRoutes(TMP);
    expect(result.jobs).toEqual([
      { filePath: 'multi.ts', name: 'multi', crons: ['0 * * * *', '30 * * * *'] },
    ]);
  });

  it('ignores underscored job files and directories', async () => {
    createFile('routes/api/hello.ts');
    createFile('crons/_internal.ts', 'export const cron = "0 * * * *"');
    createFile('crons/_private/report.ts', 'export const cron = "0 0 * * *"');

    const result = await scanRoutes(TMP);
    expect(result.jobs).toEqual([]);
  });

  it('throws when a job is missing cron export', async () => {
    createFile('routes/api/hello.ts');
    createFile('crons/sync.ts', 'export default () => {}');

    await expect(scanRoutes(TMP)).rejects.toThrow(
      "cron: Invalid job file 'sync.ts'. Add `export const cron",
    );
  });

  it('discovers queue consumers from queues directory', async () => {
    createFile('routes/api/hello.ts');
    createFile('queues/emails.ts', 'export default async () => {}');

    const result = await scanRoutes(TMP);
    expect(result.queues).toEqual([
      {
        filePath: 'emails.ts',
        name: 'emails',
        bindingName: 'QUEUE_EMAILS',
      },
    ]);
  });

  it('derives binding name from filename', async () => {
    createFile('routes/api/hello.ts');
    createFile('queues/order-notifications.ts', 'export default async () => {}');

    const result = await scanRoutes(TMP);
    expect(result.queues).toHaveLength(1);
    expect(result.queues[0].name).toBe('order-notifications');
    expect(result.queues[0].bindingName).toBe('QUEUE_ORDER_NOTIFICATIONS');
  });

  it('handles nested queue files', async () => {
    createFile('routes/api/hello.ts');
    createFile('queues/order/notifications.ts', 'export default async () => {}');

    const result = await scanRoutes(TMP);
    expect(result.queues).toHaveLength(1);
    expect(result.queues[0].name).toBe('order/notifications');
    expect(result.queues[0].bindingName).toBe('QUEUE_ORDER_NOTIFICATIONS');
  });

  it('extracts maxBatchSize and maxBatchTimeout', async () => {
    createFile('routes/api/hello.ts');
    createFile(
      'queues/emails.ts',
      'export const maxBatchSize = 50\nexport const maxBatchTimeout = 10\nexport default async () => {}',
    );

    const result = await scanRoutes(TMP);
    expect(result.queues).toHaveLength(1);
    expect(result.queues[0].maxBatchSize).toBe(50);
    expect(result.queues[0].maxBatchTimeout).toBe(10);
  });

  it('ignores _-prefixed queue files', async () => {
    createFile('routes/api/hello.ts');
    createFile('queues/_helpers.ts', 'export const x = 1');
    createFile('queues/_private/test.ts', 'export const x = 1');

    const result = await scanRoutes(TMP);
    expect(result.queues).toEqual([]);
  });

  it('handles missing queues directory', async () => {
    createFile('routes/api/hello.ts');

    const result = await scanRoutes(TMP);
    expect(result.queues).toEqual([]);
  });
});
