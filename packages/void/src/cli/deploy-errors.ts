import { parsePlatformErrorBody, PlatformApiError } from './client';

const BODY_SNIPPET_MAX = 200;

function trimSnippet(body: string): string {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= BODY_SNIPPET_MAX) {
    return collapsed;
  }
  return `${collapsed.slice(0, BODY_SNIPPET_MAX)}...`;
}

function appendDeploymentLine(message: string, deploymentId: string | null): string {
  return deploymentId ? `${message}\nDeployment: ${deploymentId}` : message;
}

/**
 * Format a server-emitted `event: 'error'` payload with an optional deployment id.
 */
export function formatDeployFailureMessage(message: string, deploymentId: string | null): string {
  return appendDeploymentLine(message, deploymentId);
}

/**
 * Format the "stream ended cleanly but no terminal event arrived" case.
 *
 * This is the only call site that should emit the bare "Connection lost during
 * deploy" message — the server closed the NDJSON stream without emitting
 * `done` or `error`, so there is no underlying error to carry.
 */
export function formatConnectionLostMessage(deploymentId: string | null): string {
  return appendDeploymentLine('Connection lost during deploy', deploymentId);
}

/**
 * Convert an exception thrown during the deploy NDJSON stream into a
 * user-facing `Error` with a readable message.
 *
 * Three cases:
 *   1. `PlatformApiError` with 409 + a JSON body carrying `{error, deployment}`
 *      — surface the server-supplied error and prefer the body's deployment id.
 *   2. Any other `PlatformApiError` — surface as `Deploy failed (HTTP <status>): <detail>`
 *      where detail is the parsed `error`/`message` field or a trimmed body snippet.
 *   3. Anything else — preserve the original message under a `Connection lost
 *      during deploy: <original>` prefix so the caller can still tell network,
 *      parse, and transport errors apart.
 */
export function formatStreamDeployError(err: unknown, deploymentId: string | null): Error {
  if (err instanceof PlatformApiError) {
    const parsed = parsePlatformErrorBody(err.body);
    const parsedError = parsed?.error ?? parsed?.message ?? null;
    const parsedDeployment = parsed?.deployment ?? null;
    const effectiveDeploymentId = parsedDeployment ?? deploymentId;

    if (err.status === 409 && parsedError) {
      return new Error(
        appendDeploymentLine(`Deploy failed: ${parsedError}`, effectiveDeploymentId),
      );
    }

    const detail = parsedError ?? trimSnippet(err.body);
    const base = detail
      ? `Deploy failed (HTTP ${err.status}): ${detail}`
      : `Deploy failed (HTTP ${err.status})`;
    return new Error(appendDeploymentLine(base, effectiveDeploymentId));
  }

  const original = err instanceof Error ? err.message : String(err);
  return new Error(
    appendDeploymentLine(`Connection lost during deploy: ${original}`, deploymentId),
  );
}
