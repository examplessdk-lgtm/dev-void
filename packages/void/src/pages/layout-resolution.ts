import type { LayoutDefinition, NamedLayoutDefinition } from './types';

export interface ResolvedLayoutEntry {
  id: string;
  definition: LayoutDefinition | NamedLayoutDefinition;
}

function isNamedLayout(
  layout: LayoutDefinition | NamedLayoutDefinition,
): layout is NamedLayoutDefinition {
  return 'name' in layout;
}

function toLayoutId(layout: LayoutDefinition | NamedLayoutDefinition): string {
  if (isNamedLayout(layout)) {
    return layout.directory
      ? `${layout.directory}/_layouts/${layout.name}`
      : `_layouts/${layout.name}`;
  }
  return layout.directory ? `${layout.directory}/layout` : 'layout';
}

/** Resolve the layout chain for a component (innermost last) */
export function resolveLayoutChain(
  componentId: string,
  layouts: LayoutDefinition[],
): LayoutDefinition[] {
  const parts = componentId.split('/');
  const chain: LayoutDefinition[] = [];

  // Check root layout
  const root = layouts.find((l) => l.directory === '');
  if (root) {
    chain.push(root);
  }

  // Check each directory level
  let dir = '';
  for (let i = 0; i < parts.length - 1; i++) {
    dir = dir ? `${dir}/${parts[i]}` : parts[i];
    const layout = layouts.find((l) => l.directory === dir);
    if (layout) {
      chain.push(layout);
    }
  }

  return chain;
}

/** Walk up directory tree to find closest _layouts/<name> */
export function resolveNamedLayout(
  name: string,
  componentId: string,
  namedLayouts: NamedLayoutDefinition[],
): NamedLayoutDefinition | null {
  const parts = componentId.split('/');
  // Build dirs from closest to root
  const dirs: string[] = [];
  let dir = '';
  for (let i = 0; i < parts.length - 1; i++) {
    dir = dir ? `${dir}/${parts[i]}` : parts[i];
    dirs.push(dir);
  }
  dirs.reverse(); // closest first
  dirs.push(''); // root last
  for (const d of dirs) {
    const found = namedLayouts.find((nl) => nl.name === name && nl.directory === d);
    if (found) {
      return found;
    }
  }
  return null;
}

export function resolveEffectiveLayoutEntries(
  page: { componentId: string; layout?: string | false },
  layouts: LayoutDefinition[],
  namedLayouts: NamedLayoutDefinition[],
): ResolvedLayoutEntry[] {
  if (page.layout === false) {
    return [];
  }

  const defaultChain = resolveLayoutChain(page.componentId, layouts).map((layout) => ({
    id: toLayoutId(layout),
    definition: layout,
  }));

  if (page.layout === undefined) {
    return defaultChain;
  }

  const isExclusive = page.layout.startsWith('!');
  const name = isExclusive ? page.layout.slice(1) : page.layout;
  // Relative paths: passthrough default chain
  if (name.startsWith('.') || name.startsWith('/')) {
    return defaultChain;
  }

  const resolved = resolveNamedLayout(name, page.componentId, namedLayouts);
  if (!resolved) {
    return defaultChain;
  }

  const namedEntry = {
    id: toLayoutId(resolved),
    definition: resolved,
  };

  if (isExclusive) {
    return [namedEntry];
  }
  if (defaultChain.length === 0) {
    return [namedEntry];
  }

  const chain = [...defaultChain];
  chain[chain.length - 1] = namedEntry;
  return chain;
}

/** Resolve effective layout chain accounting for named layout selection */
export function resolveEffectiveLayoutChain(
  page: { componentId: string; layout?: string | false },
  layouts: LayoutDefinition[],
  namedLayouts: NamedLayoutDefinition[],
): (LayoutDefinition | NamedLayoutDefinition)[] {
  return resolveEffectiveLayoutEntries(page, layouts, namedLayouts).map(
    (layout) => layout.definition,
  );
}

export function resolveLayoutIds(
  page: { componentId: string; layout?: string | false },
  layouts: LayoutDefinition[],
  namedLayouts: NamedLayoutDefinition[],
): string[] {
  return resolveEffectiveLayoutEntries(page, layouts, namedLayouts).map((layout) => layout.id);
}
