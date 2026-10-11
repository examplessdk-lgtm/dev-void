import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  // Git hooks and credential helpers must see childEnv, not process.env.
  it.skipIf(process.platform === 'win32')('runs the git children under childEnv', () => {
    const dir = mkdtempSync(join(tmpdir(), 'void-git-meta-'));
    const saved = process.env.CF_ACCESS_CLIENT_SECRET;
    try {
      mkdirSync(join(dir, 'bin'), { recursive: true });
      const shim = join(dir, 'bin', 'git');
      writeFileSync(shim, '#!/bin/sh\necho "seen=${CF_ACCESS_CLIENT_SECRET:-none}"\n');
      chmodSync(shim, 0o755);
      process.env.CF_ACCESS_CLIENT_SECRET = 'svc-secret.access';

      const scrubbed = collectGitDeployMetadata(dir, null, {}, { PATH: join(dir, 'bin') });
      expect(scrubbed.gitRef).toBe('seen=none');

      // Control: the shim does run and report the child env.
      const leaked = collectGitDeployMetadata(
        dir,
        null,
        {},
        {
          PATH: join(dir, 'bin'),
          CF_ACCESS_CLIENT_SECRET: 'svc-secret.access',
        },
      );
      expect(leaked.gitRef).toBe('seen=svc-secret.access');
    } finally {
      if (saved === undefined) {
        delete process.env.CF_ACCESS_CLIENT_SECRET;
      } else {
        process.env.CF_ACCESS_CLIENT_SECRET = saved;
      }
      rmSync(dir, { recursive: true, force: true });
    }
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
