import { reactive } from 'vue';

export type DeferredRef<T = unknown> =
  | { value: null; loading: true; error: null }
  | { value: T; loading: false; error: null }
  | { value: null; loading: false; error: Error };

type MutableDeferredRef<T = unknown> = {
  value: T | null;
  loading: boolean;
  error: Error | null;
};

export function createDeferred<T = unknown>(): DeferredRef<T> {
  return reactive({
    value: null,
    loading: true,
    error: null,
  }) as DeferredRef<T>;
}

export function resolveDeferred(ref: DeferredRef, data: unknown): void {
  const r = ref as MutableDeferredRef;
  r.value = data;
  r.loading = false;
}

export function rejectDeferred(ref: DeferredRef, error: string): void {
  const r = ref as MutableDeferredRef;
  r.error = new Error(error);
  r.loading = false;
}
