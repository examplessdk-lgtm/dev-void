import {
  cloudflareCommandDiagnostic,
  stabilizeCloudflareVersionTriggers,
  type CloudflareCommandResult,
} from '@void/deploy-cloudflare';

// Cloudflare refuses a Worker with an Analytics Engine binding (code 10089)
// until the account has used Analytics Engine once. No API turns it on, and
// the dashboard page may offer only "Create dataset"; deploying a binding from
// the dashboard once enables it (cloudflare/workers-sdk#9312).
const ANALYTICS_ENGINE_NOT_ENABLED = 10089;

export function assertCleanPlatformWrangler(
  result: CloudflareCommandResult,
  operation: string,
): void {
  if (result.status !== 0 || result.signal || result.error) {
    const diagnostic = cloudflareCommandDiagnostic({
      ...result,
      stderr: result.stderr.trim() || result.errors?.map((error) => error.message).join('\n') || '',
    });
    const analyticsEngineDisabled =
      result.errorCode === ANALYTICS_ENGINE_NOT_ENABLED ||
      result.errors?.some((error) => error.code === ANALYTICS_ENGINE_NOT_ENABLED) ||
      /\b10089\b/.test(diagnostic ?? '');
    throw new Error(
      `platform: Wrangler failed to ${operation} (${diagnostic || `exit ${result.status}`}).` +
        (analyticsEngineDisabled
          ? ' If the Analytics Engine page offers no way to enable it, follow https://void.cloud/guide/platform/installation/prerequisites#if-cloudflare-rejects-analytics-engine, then retry.'
          : ''),
    );
  }
}

export function assertPlatformTriggerStabilization(
  result: Awaited<ReturnType<typeof stabilizeCloudflareVersionTriggers>>,
  workerName: string,
  targetVersionId: string,
  operation: string,
): void {
  if (!result.ok) {
    throw new Error(
      `platform: Failed to ${operation} triggers for ${workerName} (${result.reason}).`,
    );
  }
  if (!result.targetOwnsTraffic) {
    throw new Error(
      `platform: Worker ${workerName} was superseded by ${result.activeVersionId} while publishing ${targetVersionId}; its active trigger state was repaired.`,
    );
  }
}
