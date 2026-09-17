import { describe, expect, it, vi } from 'vite-plus/test';
// The runtime builder is a Node script rather than a published package entrypoint.
// @ts-expect-error The JavaScript build helper intentionally has no declaration output.
import { resolvePlatformSourceRevision } from '../../scripts/source-revision.mjs';

describe('platform runtime source revision', () => {
  it('prefers an explicit build-system revision', () => {
    const runGit = vi.fn();

    expect(
      resolvePlatformSourceRevision({
        environment: { VOID_PLATFORM_SOURCE_REVISION: 'release-123' },
        repositoryRoot: '/repo',
        runGit,
      }),
    ).toBe('release-123');
    expect(runGit).not.toHaveBeenCalled();
  });

  it('records the checked-out commit automatically', () => {
    const runGit = vi
      .fn()
      .mockReturnValueOnce({ ok: true, stdout: '0123456789abcdef\n' })
      .mockReturnValueOnce({ ok: true, stdout: '' });

    expect(
      resolvePlatformSourceRevision({ environment: {}, repositoryRoot: '/repo', runGit }),
    ).toBe('0123456789abcdef');
    expect(runGit).toHaveBeenNthCalledWith(1, ['rev-parse', '--verify', 'HEAD'], '/repo');
    expect(runGit).toHaveBeenNthCalledWith(
      2,
      ['status', '--porcelain', '--untracked-files=normal'],
      '/repo',
    );
  });

  it('does not claim that a dirty checkout exactly matches its commit', () => {
    const runGit = vi
      .fn()
      .mockReturnValueOnce({ ok: true, stdout: '0123456789abcdef\n' })
      .mockReturnValueOnce({ ok: true, stdout: ' M platform/packages/api/src/index.ts\n' });

    expect(
      resolvePlatformSourceRevision({ environment: {}, repositoryRoot: '/repo', runGit }),
    ).toBe('0123456789abcdef-dirty');
  });

  it('leaves provenance unrecorded when Git metadata is unavailable', () => {
    expect(
      resolvePlatformSourceRevision({
        environment: {},
        repositoryRoot: '/source-archive',
        runGit: () => ({ ok: false, stdout: '' }),
      }),
    ).toBeNull();
  });

  it('leaves provenance unrecorded when checkout cleanliness cannot be verified', () => {
    const runGit = vi
      .fn()
      .mockReturnValueOnce({ ok: true, stdout: '0123456789abcdef\n' })
      .mockReturnValueOnce({ ok: false, stdout: '' });

    expect(
      resolvePlatformSourceRevision({ environment: {}, repositoryRoot: '/repo', runGit }),
    ).toBeNull();
  });
});
