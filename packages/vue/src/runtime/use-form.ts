import { VoidActionError, isAbortError, submitAction } from 'void/pages-client';
import type { ActionUrl, ResolveActionBody, ActionFormOptions } from 'void/routes';
import { reactive, ref, inject, watch } from 'vue';

function getValidationErrors(error: VoidActionError): Record<string, string> | null {
  const body = error.body;
  if (
    body &&
    typeof body === 'object' &&
    'errors' in body &&
    body.errors &&
    typeof body.errors === 'object' &&
    !Array.isArray(body.errors)
  ) {
    return body.errors as Record<string, string>;
  }
  return null;
}

export function useForm<U extends ActionUrl & string>(
  url: U,
  defaults: ResolveActionBody<U>,
  options?: ActionFormOptions<U>,
): {
  data: ResolveActionBody<U>;
  errors: Partial<Record<keyof ResolveActionBody<U> & string, string>>;
  error: VoidActionError | null;
  pending: boolean;
  isDirty: boolean;
  wasSuccessful: boolean;
  recentlySuccessful: boolean;
  post(opts?: any): Promise<void>;
  put(opts?: any): Promise<void>;
  patch(opts?: any): Promise<void>;
  delete(opts?: any): Promise<void>;
  reset(...fields: (keyof ResolveActionBody<U> & string)[]): void;
  clearErrors(...fields: (keyof ResolveActionBody<U> & string)[]): void;
  clearError(): void;
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
  const error = ref<VoidActionError | null>(null);
  const pending = ref(false);
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

  function clearError() {
    error.value = null;
  }

  async function submit(method: string, opts: any = {}) {
    pending.value = true;
    wasSuccessful.value = false;
    recentlySuccessful.value = false;
    if (successTimeout) {
      clearTimeout(successTimeout);
    }
    clearErrors();
    clearError();

    try {
      const result = await submitAction(router, resolvedUrl, {
        method,
        data: { ...data },
        ...opts,
      });

      if (!result.ok) {
        const validationErrors = getValidationErrors(result.error);
        if (validationErrors) {
          Object.assign(errors, validationErrors);
        } else {
          error.value = result.error;
        }
        return;
      }

      wasSuccessful.value = true;
      recentlySuccessful.value = true;
      defaults_ = { ...data };
      successTimeout = setTimeout(() => {
        recentlySuccessful.value = false;
      }, 2000);
    } catch (submitError) {
      if (isAbortError(submitError)) {
        return;
      }
      throw submitError;
    } finally {
      pending.value = false;
    }
  }

  return reactive({
    data,
    errors,
    error,
    pending,
    isDirty,
    wasSuccessful,
    recentlySuccessful,
    reset,
    clearErrors,
    clearError,
    post: (opts?: any) => submit('POST', opts),
    put: (opts?: any) => submit('PUT', opts),
    patch: (opts?: any) => submit('PATCH', opts),
    delete: (opts?: any) => submit('DELETE', opts),
  });
}
