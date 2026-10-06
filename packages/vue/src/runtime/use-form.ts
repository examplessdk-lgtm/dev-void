import {
  VoidActionError,
  getValidationErrors,
  isAbortError,
  isEqualFormValue,
  submitAction,
  type VisitOptions,
  type VoidRouter,
} from 'void/pages-client';
import type { ActionUrl, ResolveActionBody, ActionFormOptions } from 'void/routes';
import { reactive, ref, inject, watch } from 'vue';

type FormSubmitOptions = Omit<VisitOptions, 'method' | 'data'> & {
  data?: Record<string, unknown>;
};
type UntypedForm = {
  data: Record<string, unknown>;
  errors: Record<string, string>;
  error: VoidActionError | null;
  pending: boolean;
  hasChanges: boolean;
  wasSuccessful: boolean;
  recentlySuccessful: boolean;
  post(opts?: FormSubmitOptions): Promise<void>;
  put(opts?: FormSubmitOptions): Promise<void>;
  patch(opts?: FormSubmitOptions): Promise<void>;
  delete(opts?: FormSubmitOptions): Promise<void>;
  reset(...fields: ReadonlyArray<string>): void;
  clearErrors(...fields: ReadonlyArray<string>): void;
  clearError(): void;
};

export function useForm<U extends ActionUrl & string>(
  url: U,
  defaults: ResolveActionBody<U>,
  options?: ActionFormOptions<U>,
): {
  data: ResolveActionBody<U>;
  errors: Partial<Record<keyof ResolveActionBody<U> & string, string>>;
  error: VoidActionError | null;
  pending: boolean;
  hasChanges: boolean;
  wasSuccessful: boolean;
  recentlySuccessful: boolean;
  post(opts?: FormSubmitOptions): Promise<void>;
  put(opts?: FormSubmitOptions): Promise<void>;
  patch(opts?: FormSubmitOptions): Promise<void>;
  delete(opts?: FormSubmitOptions): Promise<void>;
  reset(...fields: ReadonlyArray<keyof ResolveActionBody<U> & string>): void;
  clearErrors(...fields: ReadonlyArray<keyof ResolveActionBody<U> & string>): void;
  clearError(): void;
};

export function useForm(
  url: string,
  defaults: Record<string, unknown>,
  options?: { params?: Record<string, string> },
): UntypedForm {
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

  const router = inject<VoidRouter | null>('__void_router', null);
  const data = reactive({ ...formDefaults }) as Record<string, unknown>;
  const errors = reactive<Record<string, string>>({});
  const error = ref<VoidActionError | null>(null);
  const pending = ref(false);
  const wasSuccessful = ref(false);
  const recentlySuccessful = ref(false);

  let defaults_ = { ...formDefaults };
  let successTimeout: ReturnType<typeof setTimeout> | null = null;

  const hasChanges = ref(false);
  watch(
    () => ({ ...data }),
    (val) => {
      hasChanges.value = Object.keys(defaults_).some(
        (key) => !isEqualFormValue(val[key], defaults_[key]),
      );
    },
    { deep: true },
  );

  function reset(...fields: ReadonlyArray<string>) {
    if (fields.length === 0) {
      Object.assign(data, { ...defaults_ });
    } else {
      for (const field of fields) {
        data[field] = defaults_[field];
      }
    }
  }

  function clearErrors(...fields: ReadonlyArray<string>) {
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

  async function submit(method: string, opts: FormSubmitOptions = {}) {
    pending.value = true;
    wasSuccessful.value = false;
    recentlySuccessful.value = false;
    if (successTimeout) {
      clearTimeout(successTimeout);
    }
    clearErrors();
    clearError();

    try {
      if (!router) {
        throw new Error('useForm(): requires the Void Router.');
      }

      const result = await submitAction(router, resolvedUrl, {
        method,
        data: { ...data },
        ...opts,
      });

      if (!result.ok) {
        const validationErrors = getValidationErrors(result.error.body);
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
    hasChanges,
    wasSuccessful,
    recentlySuccessful,
    reset,
    clearErrors,
    clearError,
    post: (opts?: FormSubmitOptions) => submit('POST', opts),
    put: (opts?: FormSubmitOptions) => submit('PUT', opts),
    patch: (opts?: FormSubmitOptions) => submit('PATCH', opts),
    delete: (opts?: FormSubmitOptions) => submit('DELETE', opts),
  });
}
