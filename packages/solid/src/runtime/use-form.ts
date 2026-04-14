import { createSignal, createMemo, useContext } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type { ActionUrl, ResolveActionBody, ActionFormOptions } from 'void/routes';
import { RouterContext, ErrorsContext } from './context';

// Typed overload — full inference from PageActionMap (requires codegen)
export function useForm<U extends ActionUrl & string>(
  url: U,
  defaults: ResolveActionBody<U>,
  options?: ActionFormOptions<U>,
): {
  data: ResolveActionBody<U>;
  setData: <K extends keyof ResolveActionBody<U> & string>(
    field: K,
    value: ResolveActionBody<U>[K],
  ) => void;
  errors: Partial<Record<keyof ResolveActionBody<U> & string, string>>;
  processing: boolean;
  isDirty: boolean;
  wasSuccessful: boolean;
  recentlySuccessful: boolean;
  post(opts?: any): void;
  put(opts?: any): void;
  patch(opts?: any): void;
  delete(opts?: any): void;
  reset(...fields: (keyof ResolveActionBody<U> & string)[]): void;
  clearErrors(...fields: (keyof ResolveActionBody<U> & string)[]): void;
};

export function useForm(
  url: string,
  defaults: Record<string, unknown>,
  options?: { params?: Record<string, string> },
): any {
  let resolvedUrl = url;

  // Strip ?action query before param resolution, then re-append
  let actionQuery = '';
  const qIdx = resolvedUrl.indexOf('?');
  if (qIdx !== -1) {
    actionQuery = resolvedUrl.slice(qIdx);
    resolvedUrl = resolvedUrl.slice(0, qIdx);
  }

  if (options?.params) {
    for (const [key, value] of Object.entries(options.params)) {
      resolvedUrl = resolvedUrl.replace(`:${key}`, encodeURIComponent(value));
    }
  }

  resolvedUrl = resolvedUrl + actionQuery;

  const router = useContext(RouterContext);
  // ErrorsContext provides the errors signal accessor — a reactive function
  // that returns the current global errors object. This allows useForm to
  // derive errors from the global state, surviving component re-creation
  // during Solid's reactive tree rebuild after router.visit().
  const globalErrors: (() => Record<string, string>) | null = useContext(ErrorsContext);
  const [data, setDataStore] = createStore<Record<string, unknown>>({ ...defaults });
  const [localErrors, setLocalErrors] = createSignal<Record<string, string>>({});
  const errors = createMemo(() => {
    const local = localErrors();
    if (Object.keys(local).length > 0) {
      return local;
    }
    // globalErrors is a signal accessor (function) on the client, or a plain
    // object on the server. Handle both cases.
    if (!globalErrors) {
      return {};
    }
    if (typeof globalErrors === 'function') {
      return globalErrors();
    }
    return globalErrors as unknown as Record<string, string>;
  });
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
      setLocalErrors({});
    } else {
      setLocalErrors((prev) => {
        const next = { ...prev };
        for (const field of fields) {
          delete next[field];
        }
        return next;
      });
    }
  }

  async function submit(method: string, opts: any = {}) {
    setProcessing(true);
    setWasSuccessful(false);
    setRecentlySuccessful(false);
    if (successTimeout) {
      clearTimeout(successTimeout);
    }
    setLocalErrors({});

    try {
      const pageData = await router?.visit(resolvedUrl, {
        method,
        data: { ...data },
        ...opts,
      });

      if (pageData?.errors) {
        setLocalErrors(pageData.errors as Record<string, string>);
        return;
      }

      setWasSuccessful(true);
      setRecentlySuccessful(true);
      defaults_ = { ...data };
      successTimeout = setTimeout(() => {
        setRecentlySuccessful(false);
      }, 2000);
    } catch {
      // Request failed
    } finally {
      setProcessing(false);
    }
  }

  return {
    get data() {
      return data;
    },
    setData,
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
    post: (opts?: any) => submit('POST', opts),
    put: (opts?: any) => submit('PUT', opts),
    patch: (opts?: any) => submit('PATCH', opts),
    delete: (opts?: any) => submit('DELETE', opts),
  };
}
