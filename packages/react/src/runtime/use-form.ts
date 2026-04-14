import { useState, useRef, useCallback, useContext, useMemo } from 'react';
import type { ActionUrl, ResolveActionBody, ActionFormOptions } from 'void/routes';
import { RouterContext } from './context';

// Typed overload — full inference from PageActionMap (requires codegen)
export function useForm<U extends ActionUrl & string>(
  url: U,
  defaults: ResolveActionBody<U>,
  options?: ActionFormOptions<U>,
): {
  data: ResolveActionBody<U>;
  setData: <K extends keyof ResolveActionBody<U> & string>(
    field: K,
    value: ResolveActionBody<U>[K],
  ) => void;
  errors: Partial<Record<keyof ResolveActionBody<U> & string, string>>;
  processing: boolean;
  isDirty: boolean;
  wasSuccessful: boolean;
  recentlySuccessful: boolean;
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

  const router = useContext(RouterContext);
  const [data, setDataState] = useState<Record<string, unknown>>({ ...defaults });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [processing, setProcessing] = useState(false);
  const [wasSuccessful, setWasSuccessful] = useState(false);
  const [recentlySuccessful, setRecentlySuccessful] = useState(false);

  const defaultsRef = useRef({ ...defaults });
  const dataRef = useRef({ ...defaults });
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isDirty = useMemo(() => {
    return Object.keys(defaultsRef.current).some(
      (key) => JSON.stringify(data[key]) !== JSON.stringify(defaultsRef.current[key]),
    );
  }, [data]);

  const setData = useCallback((field: string, value: unknown) => {
    dataRef.current = { ...dataRef.current, [field]: value };
    setDataState(dataRef.current);
  }, []);

  const reset = useCallback((...fields: string[]) => {
    if (fields.length === 0) {
      dataRef.current = { ...defaultsRef.current };
    } else {
      const next = { ...dataRef.current };
      for (const field of fields) {
        next[field] = defaultsRef.current[field];
      }
      dataRef.current = next;
    }
    setDataState(dataRef.current);
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
      if (successTimeoutRef.current) {
        clearTimeout(successTimeoutRef.current);
      }
      setErrors({});

      try {
        const pageData = await router.visit(resolvedUrl, {
          method,
          data: { ...dataRef.current },
          ...opts,
        });

        if (pageData?.errors) {
          setErrors(pageData.errors);
          return;
        }

        setWasSuccessful(true);
        setRecentlySuccessful(true);
        defaultsRef.current = { ...dataRef.current };
        successTimeoutRef.current = setTimeout(() => {
          setRecentlySuccessful(false);
        }, 2000);
      } catch {
        // Request failed
      } finally {
        setProcessing(false);
      }
    },
    [router, resolvedUrl],
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
    post: (opts?: any) => submit('POST', opts),
    put: (opts?: any) => submit('PUT', opts),
    patch: (opts?: any) => submit('PATCH', opts),
    delete: (opts?: any) => submit('DELETE', opts),
  };
}
