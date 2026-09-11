import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

type NewsletterFormProps = Readonly<{
  endpoint?: string;
  formId?: string;
  onError?: (error: Error) => void;
  onSuccess?: (email: string) => void;
}>;

type FormState = 'idle' | 'submitting' | 'success' | 'error';

export default function NewsletterForm({
  endpoint,
  formId,
  onError,
  onSuccess,
}: NewsletterFormProps) {
  const [email, setEmail] = useState('');
  const [formState, setFormState] = useState<FormState>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const resetTimeoutRef = useRef<number | null>(null);

  const isEnabled = useMemo(() => Boolean(endpoint && formId), [endpoint, formId]);

  const resetFormState = useCallback(() => {
    setFormState('idle');
  }, []);

  const scheduleReset = useCallback(() => {
    if (resetTimeoutRef.current) {
      window.clearTimeout(resetTimeoutRef.current);
    }
    resetTimeoutRef.current = window.setTimeout(resetFormState, 2000);
  }, [resetFormState]);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      if (!email || formState === 'submitting' || !isEnabled) {
        return;
      }

      setFormState('submitting');
      setErrorMessage('');

      try {
        const response = await fetch(endpoint!, {
          body: JSON.stringify({
            email,
            formId,
          }),
          headers: {
            'Content-Type': 'application/json',
          },
          method: 'POST',
        });

        if (!response.ok) {
          throw new Error('Subscription failed');
        }

        setFormState('success');
        onSuccess?.(email);
        setEmail('');
      } catch (error) {
        const normalizedError =
          error instanceof Error ? error : new Error('An unknown error occurred');
        // Swallow errors by default; callers can observe via onError.
        // (No console noise in the demo app.)
        setFormState('error');
        setErrorMessage(normalizedError.message || 'An unknown error occurred');
        onError?.(normalizedError);
      } finally {
        scheduleReset();
      }
    },
    [email, endpoint, formId, formState, isEnabled, onError, onSuccess, scheduleReset],
  );

  useEffect(() => {
    return () => {
      if (resetTimeoutRef.current) {
        window.clearTimeout(resetTimeoutRef.current);
      }
    };
  }, []);

  if (formState === 'success') {
    return (
      <div className="flex items-center gap-3 squircle border border-stroke bg-white px-5 py-4">
        <svg
          className="text-green-600 h-5 w-5 flex-shrink-0"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
        </svg>
        <span className="text-sm text-primary">Success! Please check your inbox.</span>
      </div>
    );
  }

  if (formState === 'error') {
    return (
      <div className="border-red-300 flex items-center gap-3 squircle border bg-white px-5 py-4">
        <svg
          className="text-red-600 h-5 w-5 flex-shrink-0"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            d="M6 18L18 6M6 6l12 12"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
          />
        </svg>
        <span className="text-red-600 text-sm">
          {errorMessage || 'An error occurred. Please try again.'}
        </span>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className="relative flex items-center overflow-hidden squircle border border-stroke bg-white">
        <input
          className="flex-1 bg-transparent px-3 py-3 text-sm text-primary outline-none placeholder:text-grey disabled:cursor-not-allowed disabled:opacity-50 sm:px-5 sm:py-4 sm:text-base"
          disabled={formState === 'submitting' || !isEnabled}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="Your email address"
          required
          type="email"
          value={email}
        />
        <button
          className="mr-1.5 flex-shrink-0 squircle bg-primary px-3 py-2 text-sm font-medium whitespace-nowrap text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 sm:mr-2 sm:px-6"
          disabled={formState === 'submitting' || !isEnabled}
          type="submit"
        >
          {formState === 'submitting' ? 'Subscribing...' : 'Subscribe'}
        </button>
      </div>
    </form>
  );
}
