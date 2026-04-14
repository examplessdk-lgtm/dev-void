import type { ActionUrl, ResolveActionBody, ActionFormOptions } from 'void/routes';
import { reactive, ref, inject, watch } from 'vue';

export function useForm<U extends ActionUrl & string>(
  url: U,
  defaults: ResolveActionBody<U>,
  options?: ActionFormOptions<U>,
): {
  data: ResolveActionBody<U>;
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
  const formDefaults = defaults;

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

  const router = inject<any>('__void_router', null);
  const data = reactive({ ...formDefaults }) as Record<string, unknown>;
  const errors = reactive<Record<string, string>>({});
  const processing = ref(false);
  const wasSuccessful = ref(false);
  const recentlySuccessful = ref(false);

  let defaults_ = { ...formDefaults };
  let successTimeout: ReturnType<typeof setTimeout> | null = null;

  // isDirty computed via deep watch
  const isDirty = ref(false);
  watch(
    () => ({ ...data }),
    (val) => {
      isDirty.value = Object.keys(defaults_).some(
        (key) => JSON.stringify(val[key]) !== JSON.stringify(defaults_[key]),
      );
    },
    { deep: true },
  );

  function reset(...fields: string[]) {
    if (fields.length === 0) {
      Object.assign(data, { ...defaults_ });
    } else {
      for (const field of fields) {
        (data as any)[field] = (defaults_ as any)[field];
      }
    }
  }

  function clearErrors(...fields: string[]) {
    if (fields.length === 0) {
      for (const key of Object.keys(errors)) {
        delete errors[key];
      }
    } else {
      for (const field of fields) {
        delete errors[field];
      }
    }
  }

  async function submit(method: string, opts: any = {}) {
    processing.value = true;
    wasSuccessful.value = false;
    recentlySuccessful.value = false;
    if (successTimeout) {
      clearTimeout(successTimeout);
    }
    clearErrors();

    try {
      const pageData = await router.visit(resolvedUrl, {
        method,
        data: { ...data },
        ...opts,
      });

      // Bridge validation errors from the server response into the form
      if (pageData?.errors) {
        Object.assign(errors, pageData.errors);
      }

      if (Object.keys(errors).length === 0) {
        wasSuccessful.value = true;
        recentlySuccessful.value = true;
        defaults_ = { ...data };
        successTimeout = setTimeout(() => {
          recentlySuccessful.value = false;
        }, 2000);
      }
    } catch {
      // Request failed
    } finally {
      processing.value = false;
    }
  }

  return reactive({
    data,
    errors,
    processing,
    isDirty,
    wasSuccessful,
    recentlySuccessful,
    reset,
    clearErrors,
    post: (opts?: any) => submit('POST', opts),
    put: (opts?: any) => submit('PUT', opts),
    patch: (opts?: any) => submit('PATCH', opts),
    delete: (opts?: any) => submit('DELETE', opts),
  });
}
