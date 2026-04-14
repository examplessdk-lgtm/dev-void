/**
 * Form composable for island pages. Uses fetch + page reload instead of the
 * Inertia client-side router (which is not available in island mode).
 */
export function useIslandForm(defaults: Record<string, unknown>): any {
  let data: Record<string, unknown> = $state({ ...defaults });
  let errors: Record<string, string> = $state({});
  let processing = $state(false);
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

  async function submit(url: string, method: string) {
    processing = true;
    wasSuccessful = false;
    recentlySuccessful = false;
    if (successTimeout) {
      clearTimeout(successTimeout);
    }
    clearErrors();

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
      } else if (response.status === 422) {
        const body = (await response.json()) as { errors?: Record<string, string> };
        if (body?.errors) {
          Object.assign(errors, body.errors);
        }
      }
    } catch {
      // Request failed
    } finally {
      processing = false;
    }
  }

  return {
    get data() {
      return data;
    },
    get errors() {
      return errors;
    },
    get processing() {
      return processing;
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
    post: (url: string) => submit(url, 'POST'),
    put: (url: string) => submit(url, 'PUT'),
    patch: (url: string) => submit(url, 'PATCH'),
    delete: (url: string) => submit(url, 'DELETE'),
  };
}
