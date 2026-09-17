import type { PlatformInstallationManifest } from '@void/platform';

const COMPLETE_WORKER_SECRET_UPDATE_NAMES = [
  'CF_API_TOKEN',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
] as const;

type PendingWorkerSecretUpdateIntent = Readonly<{
  generation: number | null;
  id: string;
}>;

type WorkerSecretUpdates = Readonly<Partial<Record<string, string>>>;

type WorkerSecretUpdateMarker = Readonly<{
  generation: number;
  id: string;
}>;

/**
 * Prevents a host without the encrypted values for an interrupted credential
 * update from carrying an opaque, possibly partial update into another cutover.
 */
export function assertPlatformWorkerSecretUpdateAuthority(input: {
  explicitUpdates: WorkerSecretUpdates;
  localIntent?: PendingWorkerSecretUpdateIntent;
  manifest: PlatformInstallationManifest;
}): void {
  const unresolved = unresolvedWorkerSecretUpdate(input.manifest);
  if (!unresolved) {
    return;
  }

  const latestWorkerGeneration = readLatestWorkerGeneration(input.manifest);
  const ownsCurrentIntent =
    unresolved.generation === latestWorkerGeneration &&
    input.localIntent?.id === unresolved.id &&
    (input.localIntent.generation === null ||
      input.localIntent.generation === unresolved.generation);
  if (ownsCurrentIntent || hasCompleteWorkerSecretReplacement(input.explicitUpdates)) {
    return;
  }

  throw new Error(
    'platform: An unresolved Worker credential update is owned by another encrypted recovery checkpoint. Resume on the host that owns that checkpoint, restore its encrypted pending recovery material, or provide all supported Worker credential values together as a complete replacement.',
  );
}

function unresolvedWorkerSecretUpdate(
  manifest: PlatformInstallationManifest,
): WorkerSecretUpdateMarker | null {
  const markers = manifest.steps.flatMap((step) => {
    const match = /^worker-secret-updates:(\d+):(pending|committed)$/.exec(step.key);
    return match
      ? [
          {
            generation: Number(match[1]),
            id: step.resultHash,
            state: match[2] as 'committed' | 'pending',
          },
        ]
      : [];
  });
  const latestGeneration = Math.max(0, ...markers.map((marker) => marker.generation));
  const latest = markers.filter((marker) => marker.generation === latestGeneration);
  const committed = new Set(
    latest.filter((marker) => marker.state === 'committed').map((marker) => marker.id),
  );
  const pending = latest.filter(
    (marker) => marker.state === 'pending' && !committed.has(marker.id),
  );
  if (pending.length === 0) {
    return null;
  }
  return { generation: latestGeneration, id: pending[0]!.id };
}

function readLatestWorkerGeneration(manifest: PlatformInstallationManifest): number {
  return Math.max(
    0,
    ...manifest.steps.flatMap((step) => {
      const match = /^worker-(?:cutover|secret-updates|traffic-state):(\d+)/.exec(step.key);
      return match ? [Number(match[1])] : [];
    }),
  );
}

function hasCompleteWorkerSecretReplacement(updates: WorkerSecretUpdates): boolean {
  return COMPLETE_WORKER_SECRET_UPDATE_NAMES.every(
    (name) => typeof updates[name] === 'string' && updates[name] !== '',
  );
}
