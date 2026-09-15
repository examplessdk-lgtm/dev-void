import type { ErrorHandler } from 'hono';
import type { ApiEnv } from '../env.ts';
import { OperatorError } from '../operator/common.ts';

/** Browser and JSON clients share operations, while keeping their own rendering. */
export const renderOperationError: ErrorHandler<ApiEnv> = (error, context) => {
  if (!(error instanceof OperatorError)) {
    throw error;
  }
  return context.html(<h1>{error.message}</h1>, error.status);
};
