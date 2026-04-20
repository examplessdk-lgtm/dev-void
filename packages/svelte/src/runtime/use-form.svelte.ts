import { getContext } from 'svelte';
import { VoidActionError, isAbortError, isEqualFormValue, submitAction } from 'void/pages-client';
import type { ActionUrl, ResolveActionBody, ActionFormOptions } from 'void/routes';

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

// Typed overload — full inference from PageActionMap (requires codegen)
export function useForm<U extends ActionUrl & string>(
  url: U,
  defaults: ResolveActionBody<U>,
  options?: ActionFormOptions<U>,
): {
  readonly data: ResolveActionBody<U>;
  readonly errors: Partial<Record<keyof ResolveActionBody<U> & string, string>>;
  readonly error: VoidActionError | null;
  readonly pending: boolean;
  readonly hasChanges: boolean;
  readonly wasSuccessful: boolean;
  readonly recentlySuccessful: boolean;
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

  const router = getContext<any>('__void_router');

  let data = $state({ ...defaults });
  let errors: Record<string, string> = $state({});
  let error: VoidActionError | null = $state(null);
  let pending = $state(false);
  let wasSuccessful = $state(false);
  let recentlySuccessful = $state(false);

  let defaults_ = { ...defaults };
  let successTimeout: ReturnType<typeof setTimeout> | null = null;

  const hasChanges = $derived(
    Object.keys(defaults_).some((key) => !isEqualFormValue(data[key], defaults_[key])),
  );

  function reset(...fields: string[]) {
    if (fields.length === 0) {
      data = { ...defaults_ };
    } else {
      for (const field of fields) {
        data[field] = defaults_[field];
      }
    }
  }

  function clearErrors(...fields: string[]) {
    if (fields.length === 0) {
      errors = {};
    } else {
      for (const field of fields) {
        delete errors[field];
      }
    }
  }

  function clearError() {
    error = null;
  }

  async function submit(method: string, opts: any = {}) {
    pending = true;
    wasSuccessful = false;
    recentlySuccessful = false;
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
          error = result.error;
        }
        return;
      }

      wasSuccessful = true;
      recentlySuccessful = true;
      defaults_ = { ...data };
      successTimeout = setTimeout(() => {
        recentlySuccessful = false;
      }, 2000);
    } catch (submitError) {
      if (isAbortError(submitError)) {
        return;
      }
      throw submitError;
    } finally {
      pending = false;
    }
  }

  return {
    get data() {
      return data;
    },
    get errors() {
      return errors;
    },
    get error() {
      return error;
    },
    get pending() {
      return pending;
    },
    get hasChanges() {
      return hasChanges;
    },
    get wasSuccessful() {
      return wasSuccessful;
    },
    get recentlySuccessful() {
      return recentlySuccessful;
    },
    reset,
    clearErrors,
    clearError,
    post: (opts?: any) => submit('POST', opts),
    put: (opts?: any) => submit('PUT', opts),
    patch: (opts?: any) => submit('PATCH', opts),
    delete: (opts?: any) => submit('DELETE', opts),
  };
}
