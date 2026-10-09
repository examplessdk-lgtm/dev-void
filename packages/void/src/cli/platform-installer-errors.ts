import {
  cloudflareCommandDiagnostic,
  stabilizeCloudflareVersionTriggers,
  type CloudflareCommandResult,
} from '@void/deploy-cloudflare';

export function assertCleanPlatformWrangler(
  result: CloudflareCommandResult,
  operation: string,
): void {
  if (result.status !== 0 || result.signal || result.error) {
    const diagnostic = cloudflareCommandDiagnostic({
      ...result,
      stderr: result.stderr.trim() || result.errors?.map((error) => error.message).join('\n') || '',
    });
    throw new Error(
      `platform: Wrangler failed to ${operation} (${diagnostic || `exit ${result.status}`}).`,
    );
  }
}

export function cleanPlatformCommandResult(): CloudflareCommandResult {
  return { status: 0, stderr: '', stdout: '' };
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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
