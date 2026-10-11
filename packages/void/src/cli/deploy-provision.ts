type ProvisionModule = typeof import('./provision.ts');

export let loadedProvisionModule: ProvisionModule | undefined;

/** Load the provision module once and memoize it. */
export async function loadProvisionModule(): Promise<ProvisionModule> {
  loadedProvisionModule ??= await import('./provision.ts');
  return loadedProvisionModule;
}

/**
 * The provision module for sync helpers (`resolveDeployTransport`, `deployChildEnv`,
 * `createDeployWranglerRunner`) that run after {@link loadProvisionModule} resolved.
 */
export function requireProvisionModule(): ProvisionModule {
  if (!loadedProvisionModule) {
    throw new Error('internal: provision module accessed before it was loaded');
  }
  return loadedProvisionModule;
}
