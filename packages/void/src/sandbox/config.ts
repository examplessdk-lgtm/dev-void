import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'pathe';
import type { VoidConfig } from '../config.ts';

export const DEFAULT_SANDBOX_BINDING = 'SANDBOX';
export const DEFAULT_SANDBOX_CLASS_NAME = 'Sandbox';
export const DEFAULT_SANDBOX_CONTAINER_NAME = 'void-sandbox';
export const SANDBOX_MIGRATION_TAG = 'void-sandbox-v1';

export type SandboxInstanceType =
  | 'dev'
  | 'lite'
  | 'basic'
  | 'standard'
  | 'standard-1'
  | 'standard-2'
  | 'standard-3'
  | 'standard-4';

export interface SandboxConfig {
  binding?: string;
  className?: string;
  containerName?: string;
  image?: string;
  imageBuildContext?: string;
  platformImage?: string;
  instanceType?: SandboxInstanceType;
  maxInstances?: number;
}

export interface ResolvedSandboxConfig {
  binding: string;
  className: string;
  containerName: string;
  image: string;
  imageBuildContext?: string;
  platformImage: string;
  instanceType?: SandboxInstanceType;
  maxInstances?: number;
}

const require = createRequire(import.meta.url);

export function isSandboxEnabled(config: VoidConfig): boolean {
  return config.sandbox !== undefined && config.sandbox !== false;
}

export function getDefaultSandboxImage(): string {
  return join(getSandboxPackageRoot(), 'Dockerfile');
}

export function getDefaultSandboxPlatformImage(): string {
  const pkg = JSON.parse(readFileSync(join(getSandboxPackageRoot(), 'package.json'), 'utf-8')) as {
    version?: string;
  };
  return `docker.io/cloudflare/sandbox:${pkg.version ?? 'latest'}`;
}

export function isLocalSandboxImage(image: string): boolean {
  const lowerImage = image.toLowerCase();
  return (
    isAbsolute(image) ||
    image.startsWith('./') ||
    image.startsWith('../') ||
    lowerImage === 'dockerfile' ||
    lowerImage.includes('dockerfile') ||
    lowerImage.endsWith('/dockerfile') ||
    lowerImage.endsWith('\\dockerfile')
  );
}

export function requiresSandboxPlatformImage(config: VoidConfig): boolean {
  if (typeof config.sandbox !== 'object' || config.sandbox === null) {
    return false;
  }
  return (
    typeof config.sandbox.image === 'string' &&
    isLocalSandboxImage(config.sandbox.image) &&
    config.sandbox.platformImage === undefined
  );
}

export function resolveSandboxConfig(
  config: VoidConfig,
  root: string = process.cwd(),
): ResolvedSandboxConfig {
  const raw = typeof config.sandbox === 'object' ? config.sandbox : {};
  const image = raw.image ?? getDefaultSandboxImage();
  const imageBuildContext = raw.imageBuildContext;
  const platformImage =
    raw.platformImage ??
    (raw.image && !isLocalSandboxImage(raw.image) ? raw.image : getDefaultSandboxPlatformImage());

  return {
    binding: raw.binding ?? DEFAULT_SANDBOX_BINDING,
    className: raw.className ?? DEFAULT_SANDBOX_CLASS_NAME,
    containerName: raw.containerName ?? DEFAULT_SANDBOX_CONTAINER_NAME,
    image: resolveSandboxImage(image, root),
    platformImage,
    ...(imageBuildContext && {
      imageBuildContext: isAbsolute(imageBuildContext)
        ? imageBuildContext
        : join(root, imageBuildContext),
    }),
    ...(raw.instanceType && { instanceType: raw.instanceType }),
    ...(raw.maxInstances != null && { maxInstances: raw.maxInstances }),
  };
}

function getSandboxPackageRoot(): string {
  return join(dirname(require.resolve('@cloudflare/sandbox')), '..');
}

function resolveSandboxImage(image: string, root: string): string {
  if (!isLocalSandboxImage(image) || isAbsolute(image)) {
    return image;
  }
  return join(root, image);
}
