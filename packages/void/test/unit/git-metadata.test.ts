import { describe, expect, it } from 'vite-plus/test';
import {
  buildCommitUrl,
  collectGitDeployMetadata,
  normalizeGitRemoteUrl,
} from '../../src/cli/git-metadata.ts';

describe('git deploy metadata', () => {
  it('normalizes common git remote URL formats', () => {
    expect(normalizeGitRemoteUrl('git@github.com:voidzero-dev/void.git')).toBe(
      'https://github.com/voidzero-dev/void',
    );
    expect(normalizeGitRemoteUrl('ssh://git@gitlab.com/voidzero-dev/void.git')).toBe(
      'https://gitlab.com/voidzero-dev/void',
    );
    expect(normalizeGitRemoteUrl('https://token@github.com/voidzero-dev/void.git')).toBe(
      'https://github.com/voidzero-dev/void',
    );
  });

  it('builds provider commit URLs', () => {
    expect(buildCommitUrl('https://github.com/voidzero-dev/void', 'abc123')).toBe(
      'https://github.com/voidzero-dev/void/commit/abc123',
    );
    expect(buildCommitUrl('https://gitlab.com/voidzero-dev/void', 'abc123')).toBe(
      'https://gitlab.com/voidzero-dev/void/-/commit/abc123',
    );
    expect(buildCommitUrl('https://bitbucket.org/voidzero-dev/void', 'abc123')).toBe(
      'https://bitbucket.org/voidzero-dev/void/commits/abc123',
    );
  });

  it('uses GitHub Actions metadata when available', () => {
    expect(
      collectGitDeployMetadata('/does/not/exist', 'abc123', {
        GITHUB_REF_NAME: 'main',
        GITHUB_REPOSITORY: 'voidzero-dev/void',
      }),
    ).toEqual({
      commit: 'abc123',
      commitUrl: 'https://github.com/voidzero-dev/void/commit/abc123',
      gitRef: 'main',
      repositoryUrl: 'https://github.com/voidzero-dev/void',
    });
  });
});
