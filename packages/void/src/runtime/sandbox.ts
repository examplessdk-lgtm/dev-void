import {
  Sandbox,
  getSandbox as getCloudflareSandbox,
  type SandboxOptions,
} from '@cloudflare/sandbox';
import { requireRuntimeBinding } from './env.ts';

export { Sandbox };
export type { SandboxOptions };

export const DEFAULT_SANDBOX_ID = 'default';
export const DEFAULT_SANDBOX_BINDING = 'SANDBOX';

export type VoidSandbox = Sandbox;
export type VoidSandboxOptions = SandboxOptions & { binding?: string };

let sandboxBindingName = DEFAULT_SANDBOX_BINDING;

export function __setSandboxBindingName(bindingName: string): void {
  sandboxBindingName = bindingName;
}

export function getSandbox<T extends Sandbox = Sandbox>(
  id: string = DEFAULT_SANDBOX_ID,
  options?: VoidSandboxOptions,
): T {
  const { binding = sandboxBindingName, ...sandboxOptions } = options ?? {};
  const namespace = requireRuntimeBinding<DurableObjectNamespace<T>>(binding);
  return getCloudflareSandbox<T>(namespace, id, {
    normalizeId: true,
    ...sandboxOptions,
  });
}

export const sandbox: { get: typeof getSandbox } = {
  get: getSandbox,
};
