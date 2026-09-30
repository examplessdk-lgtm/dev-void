import { ZeroTrustConfigurationError } from './configuration.ts';

export class ZeroTrustUnavailableError extends Error {
  readonly status = 409 as const;
  constructor(message: string) {
    super(message);
    this.name = 'ZeroTrustUnavailableError';
  }
}

/** Explain a deploy or rollback rejected because project routing cannot carry protection yet. */
export function zeroTrustNotReadyMessage(error: unknown): string | null {
  if (error instanceof ZeroTrustConfigurationError) {
    return 'The platform Zero Trust configuration is invalid. Ask a platform administrator to repair it, then retry.';
  }
  if (error instanceof ZeroTrustUnavailableError) {
    return `Zero Trust protection for this project is not ready: ${error.message} Run \`void project zero-trust status\` for details. A project admin or owner can run \`void project zero-trust reconcile\` once the platform is ready, then retry.`;
  }
  return null;
}

export function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4096);
}
