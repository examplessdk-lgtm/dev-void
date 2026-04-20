import { VoidActionError, categorizeActionError } from 'void/pages-client';

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
  let data: Record<string, unknown> = $state({ ...defaults });
  let errors: Record<string, string> = $state({});
  let error: VoidActionError | null = $state(null);
  let pending = $state(false);
  let wasSuccessful = $state(false);
  let recentlySuccessful = $state(false);

  let defaults_ = { ...defaults };
  let successTimeout: ReturnType<typeof setTimeout> | null = null;

  const isDirty = $derived(
    Object.keys(defaults_).some(
      (key) => JSON.stringify(data[key]) !== JSON.stringify(defaults_[key]),
    ),
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

  async function submit(url: string, method: string) {
    pending = true;
    wasSuccessful = false;
    recentlySuccessful = false;
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
        wasSuccessful = true;
        recentlySuccessful = true;
        defaults_ = { ...data };
        successTimeout = setTimeout(() => {
          recentlySuccessful = false;
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
        error = actionError;
      }
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
    get isDirty() {
      return isDirty;
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
    post: (url: string) => submit(url, 'POST'),
    put: (url: string) => submit(url, 'PUT'),
    patch: (url: string) => submit(url, 'PATCH'),
    delete: (url: string) => submit(url, 'DELETE'),
  };
}
