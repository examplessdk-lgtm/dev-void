/**
 * `wrangler secret put` creates a fetch-only draft before attaching a first secret to a Worker.
 * Accept that draft as first-deployment proof only when its complete deployable shape contains no
 * application code configuration or non-secret resource that an ordinary deploy could own.
 */
export function isWranglerSecretOnlyDraft(entry: Record<string, unknown>): boolean {
  if (!isRecord(entry.annotations)) {
    return false;
  }
  const annotationKeys = Object.keys(entry.annotations);
  if (
    entry.annotations['workers/triggered_by'] !== 'secret' ||
    annotationKeys.some((key) => key !== 'workers/triggered_by')
  ) {
    return false;
  }

  if (!isRecord(entry.resources)) {
    return false;
  }
  const { bindings, script, script_runtime: scriptRuntime } = entry.resources;
  if (
    !Array.isArray(bindings) ||
    bindings.length === 0 ||
    !bindings.every(
      (binding) =>
        isRecord(binding) &&
        typeof binding.name === 'string' &&
        binding.name.length > 0 &&
        binding.type === 'secret_text' &&
        Object.keys(binding).every((key) => key === 'name' || key === 'type'),
    )
  ) {
    return false;
  }

  if (
    !isRecord(script) ||
    !Array.isArray(script.handlers) ||
    script.handlers.length !== 1 ||
    script.handlers[0] !== 'fetch' ||
    script.placement_mode !== undefined
  ) {
    return false;
  }

  if (!isRecord(scriptRuntime)) {
    return false;
  }
  const runtimeKeys = Object.keys(scriptRuntime);
  return (
    scriptRuntime.usage_model === 'standard' &&
    // Cloudflare may omit unset limits instead of returning an empty object.
    (scriptRuntime.limits === undefined ||
      (isRecord(scriptRuntime.limits) && Object.keys(scriptRuntime.limits).length === 0)) &&
    runtimeKeys.every((key) => key === 'usage_model' || key === 'limits')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
