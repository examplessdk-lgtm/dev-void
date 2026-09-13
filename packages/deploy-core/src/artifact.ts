import type { DeployManifest } from './index.ts';

export const DEPLOY_ARTIFACT_VERSION = 1 as const;

/** Content-addressed metadata for one static asset in a deployment artifact. */
export type DeployAssetManifestEntry = {
  blake3: string;
  md5: string;
  size: number;
  /** @deprecated v1 alias of `blake3`. */
  hash: string;
};

/** Target-neutral output of packaging a Void application for deployment. */
export type DeployArtifact = Readonly<{
  artifactVersion: typeof DEPLOY_ARTIFACT_VERSION;
  manifest: Readonly<DeployManifest>;
  assetManifest: Readonly<Record<string, Readonly<DeployAssetManifestEntry>>>;
  /** Worker module bytes keyed by relative path, base64-encoded for transport. */
  workerFiles?: Readonly<Record<string, string>>;
}>;

export type DeploySourceMetadata = {
  source: string | null;
  commit: string | null;
  repositoryUrl: string | null;
  commitUrl: string | null;
  gitRef: string | null;
};

/** JSON payload accepted by the managed deployment API. */
export type DeployUploadPayload = {
  manifest: DeployManifest;
  assetManifest: Record<string, DeployAssetManifestEntry>;
  workerFiles?: Record<string, string>;
} & DeploySourceMetadata & {
    preflight: 'true' | null;
  };

/** Asset declaration accepted by the direct-upload URL endpoint. */
export type DeployAssetUploadRequest = {
  blake3: string;
  md5: string;
  size: number;
  contentType: string;
};

/** Build one target-neutral artifact before either target adds provider state. */
export function createDeployArtifact(input: {
  manifest: DeployManifest;
  assetManifest: Record<string, DeployAssetManifestEntry>;
  workerFiles?: Record<string, string>;
}): DeployArtifact {
  return {
    artifactVersion: DEPLOY_ARTIFACT_VERSION,
    manifest: input.manifest,
    assetManifest: input.assetManifest,
    ...(input.workerFiles && Object.keys(input.workerFiles).length > 0
      ? { workerFiles: input.workerFiles }
      : {}),
  };
}

/** Convert the canonical artifact into the stable hosted-platform wire shape. */
export function createDeployUploadPayload(
  artifact: DeployArtifact,
  metadata: DeploySourceMetadata & { preflight: 'true' | null },
): DeployUploadPayload {
  return {
    manifest: { ...artifact.manifest, bindings: { ...artifact.manifest.bindings } },
    assetManifest: { ...artifact.assetManifest },
    ...(artifact.workerFiles ? { workerFiles: { ...artifact.workerFiles } } : {}),
    ...metadata,
  };
}
