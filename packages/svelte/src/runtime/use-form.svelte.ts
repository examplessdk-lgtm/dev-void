import { getContext } from "svelte";
import type { ActionUrl, ResolveActionBody, ActionFormOptions } from "void/routes";

// Typed overload — full inference from PageActionMap (requires codegen)
export function useForm<U extends ActionUrl & string>(
  url: U,
  defaults: ResolveActionBody<U>,
  options?: ActionFormOptions<U>,
): {
  readonly data: ResolveActionBody<U>;
  readonly errors: Partial<Record<keyof ResolveActionBody<U> & string, string>>;
  readonly processing: boolean;
  readonly isDirty: boolean;
  readonly wasSuccessful: boolean;
  readonly recentlySuccessful: boolean;
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
  let actionQuery = "";
  const qIdx = resolvedUrl.indexOf("?");
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

  const router = getContext<any>("__void_router");

  let data = $state({ ...defaults });
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

  async function submit(method: string, opts: any = {}) {
    processing = true;
    wasSuccessful = false;
    recentlySuccessful = false;
    if (successTimeout) clearTimeout(successTimeout);
    clearErrors();

    try {
      const pageData = await router.visit(resolvedUrl, {
        method,
        data: { ...data },
        ...opts,
      });

      if (pageData?.errors) {
        Object.assign(errors, pageData.errors);
        return;
      }

      wasSuccessful = true;
      recentlySuccessful = true;
      defaults_ = { ...data };
      successTimeout = setTimeout(() => {
        recentlySuccessful = false;
      }, 2000);
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
    post: (opts?: any) => submit("POST", opts),
    put: (opts?: any) => submit("PUT", opts),
    patch: (opts?: any) => submit("PATCH", opts),
    delete: (opts?: any) => submit("DELETE", opts),
  };
}
