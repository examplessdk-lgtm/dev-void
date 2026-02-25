import type { PageActionMap } from "void/routes";

import { useState, useRef, useCallback, useContext, useMemo } from "react";

import { RouterContext } from "./context";

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
  data: PageActionMap[U]["body"];
  setData: <K extends keyof PageActionMap[U]["body"] & string>(
    field: K,
    value: PageActionMap[U]["body"][K],
  ) => void;
  errors: Partial<Record<keyof PageActionMap[U]["body"] & string, string>>;
  processing: boolean;
  isDirty: boolean;
  wasSuccessful: boolean;
  recentlySuccessful: boolean;
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
  data: T;
  setData: <K extends keyof T & string>(field: K, value: T[K]) => void;
  errors: Partial<Record<keyof T & string, string>>;
  processing: boolean;
  isDirty: boolean;
  wasSuccessful: boolean;
  recentlySuccessful: boolean;
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

  const router = useContext(RouterContext);
  const [data, setDataState] = useState<Record<string, unknown>>({ ...defaults });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [processing, setProcessing] = useState(false);
  const [wasSuccessful, setWasSuccessful] = useState(false);
  const [recentlySuccessful, setRecentlySuccessful] = useState(false);

  const defaultsRef = useRef({ ...defaults });
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isDirty = useMemo(() => {
    return Object.keys(defaultsRef.current).some(
      (key) => JSON.stringify(data[key]) !== JSON.stringify(defaultsRef.current[key]),
    );
  }, [data]);

  const setData = useCallback((field: string, value: unknown) => {
    setDataState((prev) => ({ ...prev, [field]: value }));
  }, []);

  const reset = useCallback((...fields: string[]) => {
    if (fields.length === 0) {
      setDataState({ ...defaultsRef.current });
    } else {
      setDataState((prev) => {
        const next = { ...prev };
        for (const field of fields) {
          next[field] = defaultsRef.current[field];
        }
        return next;
      });
    }
  }, []);

  const clearErrors = useCallback((...fields: string[]) => {
    if (fields.length === 0) {
      setErrors({});
    } else {
      setErrors((prev) => {
        const next = { ...prev };
        for (const field of fields) {
          delete next[field];
        }
        return next;
      });
    }
  }, []);

  const submit = useCallback(
    async (method: string, opts: any = {}) => {
      setProcessing(true);
      setWasSuccessful(false);
      setRecentlySuccessful(false);
      if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current);
      setErrors({});

      try {
        const pageData = await router.visit(resolvedUrl, {
          method,
          data: { ...data },
          ...opts,
        });

        if (pageData?.errors) {
          setErrors(pageData.errors);
          return;
        }

        setWasSuccessful(true);
        setRecentlySuccessful(true);
        defaultsRef.current = { ...data };
        successTimeoutRef.current = setTimeout(() => {
          setRecentlySuccessful(false);
        }, 2000);
      } catch {
        // Request failed
      } finally {
        setProcessing(false);
      }
    },
    [router, resolvedUrl, data],
  );

  return {
    data,
    setData,
    errors,
    processing,
    isDirty,
    wasSuccessful,
    recentlySuccessful,
    reset,
    clearErrors,
    post: (opts?: any) => submit("POST", opts),
    put: (opts?: any) => submit("PUT", opts),
    patch: (opts?: any) => submit("PATCH", opts),
    delete: (opts?: any) => submit("DELETE", opts),
  };
}
