import type { PageActionMap } from "void/routes";

import { getContext } from "svelte";

type HasParams<U extends keyof PageActionMap> = PageActionMap[U] extends { params: infer P }
  ? P extends Record<string, string>
    ? true
    : false
  : false;

type FormOptions<U extends keyof PageActionMap> =
  HasParams<U> extends true
    ? { params: PageActionMap[U] extends { params: infer P } ? P : never }
    : { params?: never };

// Typed overload — full inference from PageActionMap (requires codegen)
export function useForm<U extends keyof PageActionMap & string>(
  url: U,
  defaults: PageActionMap[U]["body"],
  options?: FormOptions<U>,
): {
  readonly data: PageActionMap[U]["body"];
  readonly errors: Partial<Record<keyof PageActionMap[U]["body"] & string, string>>;
  readonly processing: boolean;
  readonly isDirty: boolean;
  readonly wasSuccessful: boolean;
  readonly recentlySuccessful: boolean;
  post(opts?: any): void;
  put(opts?: any): void;
  patch(opts?: any): void;
  delete(opts?: any): void;
  reset(...fields: (keyof PageActionMap[U]["body"] & string)[]): void;
  clearErrors(...fields: (keyof PageActionMap[U]["body"] & string)[]): void;
};

// Untyped fallback — manual generic for use without codegen
export function useForm<T extends Record<string, unknown>>(
  url: string,
  defaults: T,
  options?: { params?: Record<string, string> },
): {
  readonly data: T;
  readonly errors: Partial<Record<keyof T & string, string>>;
  readonly processing: boolean;
  readonly isDirty: boolean;
  readonly wasSuccessful: boolean;
  readonly recentlySuccessful: boolean;
  post(opts?: any): void;
  put(opts?: any): void;
  patch(opts?: any): void;
  delete(opts?: any): void;
  reset(...fields: (keyof T & string)[]): void;
  clearErrors(...fields: (keyof T & string)[]): void;
};

export function useForm(
  url: string,
  defaults: Record<string, unknown>,
  options?: { params?: Record<string, string> },
): any {
  let resolvedUrl = url;
  if (options?.params) {
    for (const [key, value] of Object.entries(options.params)) {
      resolvedUrl = resolvedUrl.replace(`:${key}`, encodeURIComponent(value));
    }
  }

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
