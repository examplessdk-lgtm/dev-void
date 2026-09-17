import { randomBytes } from 'node:crypto';
import {
  createPlatformInstallationManifest,
  recordInstallationStep,
  transitionInstallation,
  type PlatformInstallationManifest,
} from '@void/platform';
import type { PlatformInstallPlan } from './platform-plan.ts';
import { writeInstallationManifest, writePendingInstallationSecrets } from './platform-registry.ts';

const STARTED = 'credential-setup:v1';
const COMPLETED = 'credential-setup-complete:v1';

export function isPlatformSetupDraft(manifest: PlatformInstallationManifest): boolean {
  return (
    manifest.status === 'planned' &&
    manifest.resources.length === 0 &&
    manifest.endpoints.apiUrl === null &&
    manifest.steps.some((step) => step.key === STARTED) &&
    !manifest.steps.some((step) => step.key === COMPLETED)
  );
}

export function savePlatformSetupDraft(
  plan: PlatformInstallPlan,
  version: string,
): PlatformInstallationManifest {
  const now = new Date().toISOString();
  let manifest = createPlatformInstallationManifest({
    account: plan.account,
    deployment: plan.deployment,
    id: plan.installationId,
    createdAt: now,
    platformVersion: version,
    ownershipNonce: randomBytes(32).toString('base64url'),
  });
  manifest = transitionInstallation(manifest, 'planned', now);
  manifest = recordInstallationStep(
    manifest,
    { key: STARTED, completedAt: now, resultHash: plan.installationId },
    now,
  );
  writeInstallationManifest(manifest);
  // Establish secure storage before collecting any secret.
  writePendingInstallationSecrets(manifest, {});
  return manifest;
}

export function completePlatformSetupDraft(
  manifest: PlatformInstallationManifest,
): PlatformInstallationManifest {
  const now = new Date().toISOString();
  const completed = recordInstallationStep(
    manifest,
    { key: COMPLETED, completedAt: now, resultHash: manifest.id },
    now,
  );
  writeInstallationManifest(completed);
  return completed;
}
