export const REASON_REQUESTS_EXCEEDED = 'requests_exceeded';
export const REASON_SANDBOX_RUNTIME_EXCEEDED = 'sandbox_runtime_exceeded';

const USAGE_LIMIT_REASONS = new Set([REASON_REQUESTS_EXCEEDED, REASON_SANDBOX_RUNTIME_EXCEEDED]);

/**
 * Returns true when the user is suspended by an admin action (not by
 * automatic usage-limit enforcement). Usage-suspended users must retain
 * dashboard and API access so they can inspect usage and upgrade.
 */
export function isAdminSuspended(suspendedReason: string | null): boolean {
  return suspendedReason !== null && !USAGE_LIMIT_REASONS.has(suspendedReason);
}

export function routingSuspensionReason(suspendedReason: string | null): string | null {
  return suspendedReason === REASON_REQUESTS_EXCEEDED || isAdminSuspended(suspendedReason)
    ? suspendedReason
    : null;
}

/**
 * ROUTING key present while a project's owner is suspended by an administrator.
 * Cron firing (CronScheduler) and queue relay (dispatch) pause while it exists.
 * Usage-limit suspensions never write it.
 */
export function projectSuspensionKey(projectId: string): string {
  return `project-suspended:${projectId}`;
}
