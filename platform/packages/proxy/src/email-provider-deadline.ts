export const EMAIL_PROVIDER_DEADLINE_MS = 30_000;
const EMAIL_PROVIDER_BATCH_DEADLINE_MS = 60_000;

export class EmailProviderTimeoutError extends Error {
  constructor() {
    super('email provider outcome unknown after timeout');
    this.name = 'EmailProviderTimeoutError';
  }
}

/** One absolute batch budget, with a shorter ceiling for each provider submission. */
export function createEmailProviderDeadline(totalMs = EMAIL_PROVIDER_BATCH_DEADLINE_MS) {
  const deadline = Date.now() + totalMs;
  return {
    remainingMs(reserveMs = 0): number {
      return Math.max(0, deadline - Date.now() - reserveMs);
    },
    expired(reserveMs = 0): boolean {
      return Date.now() >= deadline - reserveMs;
    },
    async run<T>(submit: () => Promise<T>, reserveMs = 0): Promise<T> {
      const remaining = Math.min(EMAIL_PROVIDER_DEADLINE_MS, deadline - Date.now() - reserveMs);
      if (remaining <= 0) {
        throw new EmailProviderTimeoutError();
      }
      const work = submit();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new EmailProviderTimeoutError()), remaining);
          }),
        ]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    },
  };
}

export type EmailProviderDeadline = ReturnType<typeof createEmailProviderDeadline>;
