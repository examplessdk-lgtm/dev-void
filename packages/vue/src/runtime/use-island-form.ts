import { reactive, ref, watch } from 'vue';

/**
 * Form composable for island pages. Uses fetch + page reload instead of the
 * Inertia client-side router (which is not available in island mode).
 */
export function useIslandForm(defaults: Record<string, unknown>): any {
  const data = reactive({ ...defaults }) as Record<string, unknown>;
  const errors = reactive<Record<string, string>>({});
  const processing = ref(false);
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

  async function submit(url: string, method: string) {
    processing.value = true;
    wasSuccessful.value = false;
    recentlySuccessful.value = false;
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
        wasSuccessful.value = true;
        recentlySuccessful.value = true;
        defaults_ = { ...data };
        successTimeout = setTimeout(() => {
          recentlySuccessful.value = false;
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
    post: (url: string) => submit(url, 'POST'),
    put: (url: string) => submit(url, 'PUT'),
    patch: (url: string) => submit(url, 'PATCH'),
    delete: (url: string) => submit(url, 'DELETE'),
  });
}
