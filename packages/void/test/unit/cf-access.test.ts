import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cfAccessHeaders } from '../../src/shared/cf-access';

describe('cfAccessHeaders', () => {
  it('returns empty when nothing is set', () => {
    expect(cfAccessHeaders({})).toEqual({});
  });

  it('prefers service-token pair over CF_ACCESS_TOKEN', () => {
    expect(
      cfAccessHeaders({
        CF_ACCESS_CLIENT_ID: 'id',
        CF_ACCESS_CLIENT_SECRET: 'secret',
        CF_ACCESS_TOKEN: 'jwt',
      }),
    ).toEqual({
      'CF-Access-Client-Id': 'id',
      'CF-Access-Client-Secret': 'secret',
    });
  });

  it('falls back to CF_ACCESS_TOKEN when service token is incomplete', () => {
    expect(
      cfAccessHeaders({
        CF_ACCESS_CLIENT_ID: 'id',
        CF_ACCESS_TOKEN: 'jwt',
      }),
    ).toEqual({ 'cf-access-token': 'jwt' });
  });

  it('ignores empty strings', () => {
    expect(
      cfAccessHeaders({
        CF_ACCESS_CLIENT_ID: '',
        CF_ACCESS_CLIENT_SECRET: '',
        CF_ACCESS_TOKEN: '',
      }),
    ).toEqual({});
  });

  it('ignores non-string values', () => {
    expect(
      cfAccessHeaders({
        CF_ACCESS_CLIENT_ID: 123,
        CF_ACCESS_CLIENT_SECRET: { a: 1 },
        CF_ACCESS_TOKEN: null,
      }),
    ).toEqual({});
  });
});

const spawnSyncMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawnSync: (...args: Array<unknown>) => spawnSyncMock(...args),
}));

describe('ensureCloudflaredToken', () => {
  beforeEach(() => {
    vi.resetModules();
    spawnSyncMock.mockReset();
    delete process.env.CF_ACCESS_CLIENT_ID;
    delete process.env.CF_ACCESS_CLIENT_SECRET;
    delete process.env.CF_ACCESS_TOKEN;
  });

  afterEach(() => {
    delete process.env.CF_ACCESS_TOKEN;
  });

  it('does not probe when service token is present', async () => {
    process.env.CF_ACCESS_CLIENT_ID = 'id';
    process.env.CF_ACCESS_CLIENT_SECRET = 'secret';
    const { ensureCloudflaredToken } = await import('../../src/cli/cf-access');
    ensureCloudflaredToken('https://api.staging.void.cloud');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('does not probe when CF_ACCESS_TOKEN is already set', async () => {
    process.env.CF_ACCESS_TOKEN = 'jwt';
    const { ensureCloudflaredToken } = await import('../../src/cli/cf-access');
    ensureCloudflaredToken('https://api.staging.void.cloud');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('does not probe non-gated hosts', async () => {
    const { ensureCloudflaredToken } = await import('../../src/cli/cf-access');
    ensureCloudflaredToken('https://api.void.cloud');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('does not poison the cache when a non-gated host is hit first', async () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: 'mocked-jwt' });
    const { ensureCloudflaredToken } = await import('../../src/cli/cf-access');

    // First: non-gated host. Should be a noop.
    ensureCloudflaredToken('https://api.void.cloud');
    expect(spawnSyncMock).not.toHaveBeenCalled();

    // Second: gated host. Should still probe — this is the regression fix.
    ensureCloudflaredToken('https://api.staging.void.cloud');
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(process.env.CF_ACCESS_TOKEN).toBe('mocked-jwt');
  });

  it('caches per gated host so the same host is not probed twice', async () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: 'jwt-a' });
    const { ensureCloudflaredToken } = await import('../../src/cli/cf-access');

    ensureCloudflaredToken('https://api.staging.void.cloud');
    ensureCloudflaredToken('https://api.staging.void.cloud/some/path');
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it('skips re-probing once CF_ACCESS_TOKEN has been populated by an earlier probe', async () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: 'jwt-a' });
    const { ensureCloudflaredToken } = await import('../../src/cli/cf-access');

    // First gated host triggers probe and sets the env var.
    ensureCloudflaredToken('https://api.staging.void.cloud');
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(process.env.CF_ACCESS_TOKEN).toBe('jwt-a');

    // Second gated host (different) sees CF_ACCESS_TOKEN already set, skips.
    ensureCloudflaredToken('https://proxy.staging.void.cloud');
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });
});
