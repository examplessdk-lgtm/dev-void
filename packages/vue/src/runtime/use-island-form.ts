import { VoidActionError, categorizeActionError } from 'void/pages-client';
import { reactive, ref, watch } from 'vue';

function getValidationErrors(body: unknown): Record<string, string> | null {
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

async function readActionErrorBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') || '';
  try {
    if (contentType.includes('application/json')) {
      return await response.json();
    }
    const text = await response.text();
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Form composable for island pages. Uses fetch + page reload instead of the
 * Inertia client-side router (which is not available in island mode).
 */
export function useIslandForm(defaults: Record<string, unknown>): any {
  const data = reactive({ ...defaults }) as Record<string, unknown>;
  const errors = reactive<Record<string, string>>({});
  const error = ref<VoidActionError | null>(null);
  const pending = ref(false);
  const wasSuccessful = ref(false);
  const recentlySuccessful = ref(false);

  let defaults_ = { ...defaults };
  let successTimeout: ReturnType<typeof setTimeout> | null = null;

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

  async function submit(url: string, method: string) {
    pending.value = true;
    wasSuccessful.value = false;
    recentlySuccessful.value = false;
    if (successTimeout) {
      clearTimeout(successTimeout);
    }
    clearErrors();
    clearError();

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
        wasSuccessful.value = true;
        recentlySuccessful.value = true;
        defaults_ = { ...data };
        successTimeout = setTimeout(() => {
          recentlySuccessful.value = false;
        }, 2000);
        window.location.reload();
      } else if (!response.ok) {
        const body = await readActionErrorBody(response);
        const actionError = new VoidActionError({
          body,
          status: response.status,
          statusText: response.statusText,
          url,
        });
        const validationErrors = response.status === 422 ? getValidationErrors(body) : null;
        if (validationErrors) {
          Object.assign(errors, validationErrors);
          return;
        }
        if (categorizeActionError(response.status) === 'boundary') {
          throw actionError;
        }
        error.value = actionError;
      }
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
    post: (url: string) => submit(url, 'POST'),
    put: (url: string) => submit(url, 'PUT'),
    patch: (url: string) => submit(url, 'PATCH'),
    delete: (url: string) => submit(url, 'DELETE'),
  });
}
