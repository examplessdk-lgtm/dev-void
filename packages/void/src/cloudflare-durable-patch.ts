import { isDeepStrictEqual } from 'node:util';

type Config = Record<string, unknown>;
type Entry = Record<string, unknown>;

function entries(value: unknown, label: string): Array<Entry> {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))
  ) {
    throw new Error(`Cloudflare ${label} configuration must be an array of objects.`);
  }
  return value as Array<Entry>;
}

function byIdentity(
  rows: Array<Entry>,
  field: string,
  label: string,
  unique = false,
): Map<string, Entry> {
  const map = new Map<string, Entry>();
  for (const row of rows) {
    const id = row[field];
    if (typeof id !== 'string' || !id) {
      throw new Error(`Cloudflare ${label} is missing its ${field}.`);
    }
    const previous = map.get(id);
    if (previous && unique) {
      throw new Error(`Cloudflare ${label} ${JSON.stringify(id)} is configured more than once.`);
    }
    if (previous && !isDeepStrictEqual(previous, row)) {
      throw new Error(`Cloudflare ${label} ${JSON.stringify(id)} has conflicting configuration.`);
    }
    if (!previous) {
      map.set(id, row);
    }
  }
  return map;
}

/** Finish cumulative feature planning without repeating the Cloudflare plugin's array fallback. */
export function finalizeDurableObjectPatch(
  resolved: Config,
  patch: Config,
  generatedLocalBindings: Array<{ name: string; class_name: string }>,
): void {
  const baselineObjects = resolved.durable_objects as { bindings?: unknown } | undefined;
  const pendingObjects = patch.durable_objects as { bindings?: unknown } | undefined;
  const baselineBindings = byIdentity(
    entries(baselineObjects?.bindings, 'Durable Object bindings'),
    'name',
    'Durable Object binding',
    true,
  );
  const pendingBindings = byIdentity(
    entries(pendingObjects?.bindings, 'Durable Object bindings'),
    'name',
    'Durable Object binding',
  );
  const history = entries(resolved.migrations, 'Durable Object migrations');
  const baselineMigrations = byIdentity(history, 'tag', 'Durable Object migration', true);
  for (const local of generatedLocalBindings) {
    for (const map of [baselineBindings, pendingBindings]) {
      const existing = map.get(local.name);
      // SDK classes are exported by this Worker. A same-class remote binding would run another
      // Worker's code; retain unrelated authored remote bindings, but never silently adopt it.
      if (
        existing &&
        (existing.class_name !== local.class_name ||
          existing.script_name !== undefined ||
          existing.environment !== undefined)
      ) {
        throw new Error(
          `Cloudflare generated Durable Object binding ${JSON.stringify(local.name)} conflicts with its configured identity.`,
        );
      }
    }
  }
  if (pendingObjects?.bindings !== undefined) {
    const additions: Array<Entry> = [];
    for (const [name, row] of pendingBindings) {
      const existing = baselineBindings.get(name);
      if (existing && !isDeepStrictEqual(existing, row)) {
        throw new Error(
          `Cloudflare Durable Object binding ${JSON.stringify(name)} has conflicting configuration.`,
        );
      }
      if (!existing) {
        additions.push(row);
      }
    }
    patch.durable_objects = { ...pendingObjects, bindings: additions };
  }
  if (patch.migrations !== undefined) {
    const pending = byIdentity(
      entries(patch.migrations, 'Durable Object migrations'),
      'tag',
      'Durable Object migration',
    );
    const additions: Array<Entry> = [];
    for (const [tag, row] of pending) {
      const previous = baselineMigrations.get(tag);
      if (previous && !isDeepStrictEqual(previous, row)) {
        throw new Error(
          `Cloudflare Durable Object migration ${JSON.stringify(tag)} has conflicting configuration.`,
        );
      }
      if (!previous) {
        additions.push(row);
      }
    }
    // defu prepends the patch to the fallback. Migrations need the original ordered history
    // followed by additions, so emit that complete sequence once. Only the in-memory fallback
    // is cleared; authored configuration and the lock retain their original history.
    patch.migrations = [...history, ...additions];
    resolved.migrations = [];
  }
}
