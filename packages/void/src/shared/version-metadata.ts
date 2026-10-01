import { bindingNamesForField, findBindingNameOwner } from '../cli/wrangler.ts';

/** Build-only marker: an existing-site handoff must not add Worker bindings. */
export const CLOUDFLARE_PRESERVE_BINDINGS_BUILD_ENV = 'VOID_CLOUDFLARE_PRESERVE_BINDINGS';
export const DEFAULT_VERSION_METADATA_BINDING = '__VOID_VERSION_METADATA';

/** Keep the authored singleton name, and reject a cross-type binding collision. */
export function readVersionMetadataBinding(config: Record<string, unknown>): string | undefined {
  const names = bindingNamesForField('version_metadata', config.version_metadata);
  const name = names[0];
  if (!name) {
    return undefined;
  }
  const owner = findBindingNameOwner(config, 'version_metadata', name);
  if (owner) {
    throw new Error(`Cloudflare version metadata binding ${name} conflicts with ${owner}.`);
  }
  return name;
}

/** Self-metadata adds no remote resource or plan entitlement. */
export function selectNativeVersionMetadataBinding(
  config: Record<string, unknown>,
  options: { nativeBuild: boolean; preserveBindings: boolean },
): string | undefined {
  if (!options.nativeBuild) {
    return undefined;
  }
  const authored = readVersionMetadataBinding(config);
  if (authored || options.preserveBindings) {
    return authored;
  }
  const owner = findBindingNameOwner(config, 'version_metadata', DEFAULT_VERSION_METADATA_BINDING);
  if (owner) {
    throw new Error(
      `Cloudflare version metadata binding ${DEFAULT_VERSION_METADATA_BINDING} conflicts with ${owner}.`,
    );
  }
  return DEFAULT_VERSION_METADATA_BINDING;
}
