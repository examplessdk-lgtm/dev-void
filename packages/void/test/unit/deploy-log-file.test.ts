import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const home = vi.hoisted(() => ({ dir: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => home.dir };
});

const { openDeployLog } = await import('../../src/cli/log-file.ts');

describe('openDeployLog', () => {
  beforeEach(() => {
    home.dir = mkdtempSync(join(tmpdir(), 'void-deploy-log-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(home.dir, { recursive: true, force: true });
  });

  // Two deploys started at the same moment (for example two apps deployed in
  // parallel from one machine) must not interleave their records in one file.
  it('gives loggers opened in the same millisecond their own files', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-06T00:00:00.000Z'));

    const first = openDeployLog();
    const second = openDeployLog();

    expect(first.path).not.toBeNull();
    expect(second.path).not.toBeNull();
    expect(first.path).not.toBe(second.path);
    expect(first.path).toContain(String(process.pid));

    first.info('first_only');
    second.info('second_only');
    await first.close();
    await second.close();

    const firstText = readFileSync(first.path!, 'utf8');
    const secondText = readFileSync(second.path!, 'utf8');
    expect(firstText).toContain('first_only');
    expect(firstText).not.toContain('second_only');
    expect(secondText).toContain('second_only');
    expect(secondText).not.toContain('first_only');
  });
});
