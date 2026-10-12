import { spawnSync } from 'node:child_process';

export function resolvePlatformSourceRevision({ repositoryRoot }) {
  const explicit = process.env.VOID_PLATFORM_SOURCE_REVISION;
  if (explicit) {
    return explicit;
  }

  const revision = runGit(['rev-parse', '--verify', 'HEAD'], repositoryRoot);
  if (!revision.ok) {
    return null;
  }

  const sourceRevision = revision.stdout.trim();
  if (!sourceRevision) {
    return null;
  }

  const status = runGit(['status', '--porcelain', '--untracked-files=normal'], repositoryRoot);
  if (!status.ok) {
    return null;
  }

  return status.stdout.trim() ? `${sourceRevision}-dirty` : sourceRevision;
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
  };
}
