export const DEFERRED: unique symbol = Symbol('deferred');

export interface DeferredSentinel {
  [DEFERRED]: true;
  group: string | null;
  resolver: (c: any) => Promise<unknown>;
}

/** Reactive wrapper for a deferred prop on the client. */
export type Deferred<T> =
  | { readonly loading: true; readonly value: null; readonly error: null }
  | { readonly loading: false; readonly value: T; readonly error: null }
  | { readonly loading: false; readonly value: null; readonly error: Error };

/** Extract the props type from a typed handler (loader). */
export type InferProps<T> = T extends { __output: infer R } ? R : never;

// Overloads
export function defer<T>(resolver: (c: any) => Promise<T>): Deferred<T>;
export function defer<T>(group: string, resolver: (c: any) => Promise<T>): Deferred<T>;
export function defer(
  groupOrResolver: string | ((c: any) => Promise<unknown>),
  maybeResolver?: (c: any) => Promise<unknown>,
): any {
  const [group, resolver] =
    typeof groupOrResolver === 'string'
      ? [groupOrResolver, maybeResolver!]
      : [null, groupOrResolver];
  return { [DEFERRED]: true, group, resolver };
}

export interface ResolvedDeferredGroup {
  resolver: (c: any) => Promise<unknown>;
  keys: string[];
}

/**
 * Separate a loader's return value into immediate props and deferred sentinels.
 * For single-prop deferred (group=null), the object key becomes the group name.
 * For named groups, all keys sharing the same group name are collected.
 */
export function separateDeferred(props: Record<string, unknown>): {
  immediateProps: Record<string, unknown>;
  deferredMap: Record<string, ResolvedDeferredGroup>;
} {
  const immediateProps: Record<string, unknown> = {};
  const deferredMap: Record<string, ResolvedDeferredGroup> = {};

  for (const [key, value] of Object.entries(props)) {
    if (value && typeof value === 'object' && DEFERRED in value) {
      const sentinel = value as DeferredSentinel;
      const groupName = sentinel.group ?? key;
      if (!deferredMap[groupName]) {
        deferredMap[groupName] = { resolver: sentinel.resolver, keys: [] };
      }
      deferredMap[groupName].keys.push(key);
      // Include a loading placeholder so SSR components receive the prop
      immediateProps[key] = { value: null, loading: true, error: null };
    } else {
      immediateProps[key] = value;
    }
  }

  return { immediateProps, deferredMap };
}
