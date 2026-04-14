import { useState, useRef, useCallback, useMemo } from 'react';

export interface IslandFormReturn<T extends Record<string, unknown>> {
  data: T;
  setData: <K extends keyof T & string>(field: K, value: T[K]) => void;
  errors: Record<string, string>;
  processing: boolean;
  isDirty: boolean;
  wasSuccessful: boolean;
  recentlySuccessful: boolean;
  reset: (...fields: (keyof T & string)[]) => void;
  clearErrors: (...fields: string[]) => void;
  post: (url: string) => void;
  put: (url: string) => void;
  patch: (url: string) => void;
  delete: (url: string) => void;
}

/**
 * Form hook for island pages. Uses fetch + page reload instead of the
 * Inertia client-side router (which is not available in island mode).
 */
export function useIslandForm<T extends Record<string, unknown>>(defaults: T): IslandFormReturn<T> {
  const [data, setDataState] = useState<T>({ ...defaults });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [processing, setProcessing] = useState(false);
  const [wasSuccessful, setWasSuccessful] = useState(false);
  const [recentlySuccessful, setRecentlySuccessful] = useState(false);
  const defaultsRef = useRef({ ...defaults });
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isDirty = useMemo(() => {
    return Object.keys(defaultsRef.current).some(
      (key) => JSON.stringify(data[key]) !== JSON.stringify(defaultsRef.current[key as keyof T]),
    );
  }, [data]);

  const setData = useCallback(<K extends keyof T & string>(field: K, value: T[K]) => {
    setDataState((prev) => ({ ...prev, [field]: value }));
  }, []);

  const reset = useCallback((...fields: (keyof T & string)[]) => {
    if (fields.length === 0) {
      setDataState({ ...defaultsRef.current } as T);
    } else {
      setDataState((prev) => {
        const next = { ...prev };
        for (const field of fields) {
          next[field] = defaultsRef.current[field] as T[typeof field];
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
        for (const f of fields) {
          delete next[f];
        }
        return next;
      });
    }
  }, []);

  const submit = useCallback(
    async (url: string, method: string) => {
      setProcessing(true);
      setWasSuccessful(false);
      setRecentlySuccessful(false);
      if (successTimeoutRef.current) {
        clearTimeout(successTimeoutRef.current);
      }
      setErrors({});

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
          setWasSuccessful(true);
          setRecentlySuccessful(true);
          defaultsRef.current = { ...data };
          successTimeoutRef.current = setTimeout(() => setRecentlySuccessful(false), 2000);
          window.location.reload();
        } else if (response.status === 422) {
          const body = (await response.json()) as { errors?: Record<string, string> };
          if (body?.errors) {
            setErrors(body.errors);
          }
        }
      } catch {
        // Request failed
      } finally {
        setProcessing(false);
      }
    },
    [data],
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
    post: (url: string) => submit(url, 'POST'),
    put: (url: string) => submit(url, 'PUT'),
    patch: (url: string) => submit(url, 'PATCH'),
    delete: (url: string) => submit(url, 'DELETE'),
  };
}
