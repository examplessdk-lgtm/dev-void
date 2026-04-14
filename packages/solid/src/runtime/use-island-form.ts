import { createSignal, createMemo } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';

export interface IslandFormReturn<T extends Record<string, unknown>> {
  data: T;
  setData: <K extends keyof T & string>(field: K, value: T[K]) => void;
  errors: Record<string, string>;
  processing: boolean;
  isDirty: boolean;
  wasSuccessful: boolean;
  recentlySuccessful: boolean;
  reset: (...fields: (keyof T & string)[]) => void;
  clearErrors: (...fields: string[]) => void;
  post: (url: string) => void;
  put: (url: string) => void;
  patch: (url: string) => void;
  delete: (url: string) => void;
}

/**
 * Form composable for island pages. Uses fetch + page reload instead of the
 * Inertia client-side router (which is not available in island mode).
 */
export function useIslandForm<T extends Record<string, unknown>>(defaults: T): IslandFormReturn<T> {
  const [data, setDataStore] = createStore<Record<string, unknown>>({ ...defaults });
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const [processing, setProcessing] = createSignal(false);
  const [wasSuccessful, setWasSuccessful] = createSignal(false);
  const [recentlySuccessful, setRecentlySuccessful] = createSignal(false);

  let defaults_ = { ...defaults };
  let successTimeout: ReturnType<typeof setTimeout> | null = null;

  const isDirty = createMemo(() => {
    return Object.keys(defaults_).some(
      (key) => JSON.stringify(data[key]) !== JSON.stringify(defaults_[key]),
    );
  });

  function setData(field: string, value: unknown) {
    setDataStore(field, value);
  }

  function reset(...fields: string[]) {
    if (fields.length === 0) {
      setDataStore(reconcile({ ...defaults_ }));
    } else {
      for (const field of fields) {
        setDataStore(field, defaults_[field]);
      }
    }
  }

  function clearErrors(...fields: string[]) {
    if (fields.length === 0) {
      setErrors({});
    } else {
      setErrors((prev) => {
        const next = { ...prev };
        for (const f of fields) {
          delete next[f];
        }
        return next;
      });
    }
  }

  async function submit(url: string, method: string) {
    setProcessing(true);
    setWasSuccessful(false);
    setRecentlySuccessful(false);
    if (successTimeout) {
      clearTimeout(successTimeout);
    }
    setErrors({});

    try {
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (response.redirected) {
        window.location.href = response.url;
        return;
      }

      if (response.ok) {
        setWasSuccessful(true);
        setRecentlySuccessful(true);
        defaults_ = { ...data } as typeof defaults_;
        successTimeout = setTimeout(() => setRecentlySuccessful(false), 2000);
        window.location.reload();
      } else if (response.status === 422) {
        const body = (await response.json()) as { errors?: Record<string, string> };
        if (body?.errors) {
          setErrors(body.errors);
        }
      }
    } catch {
      // Request failed
    } finally {
      setProcessing(false);
    }
  }

  return {
    get data() {
      return data as T;
    },
    setData: setData as IslandFormReturn<T>['setData'],
    get errors() {
      return errors();
    },
    get processing() {
      return processing();
    },
    get isDirty() {
      return isDirty();
    },
    get wasSuccessful() {
      return wasSuccessful();
    },
    get recentlySuccessful() {
      return recentlySuccessful();
    },
    reset,
    clearErrors,
    post: (url: string) => submit(url, 'POST'),
    put: (url: string) => submit(url, 'PUT'),
    patch: (url: string) => submit(url, 'PATCH'),
    delete: (url: string) => submit(url, 'DELETE'),
  };
}
