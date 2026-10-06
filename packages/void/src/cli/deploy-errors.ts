import { isCliOutdatedError, parsePlatformErrorBody, PlatformApiError } from './client.ts';
import { platformErrorMessage } from './platform-errors.ts';

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

function appendLogLine(message: string, logPath: string | null | undefined): string {
  return logPath ? `${message}\nDetailed log: ${logPath}` : message;
}

function appendTrailingLines(
  message: string,
  deploymentId: string | null,
  logPath: string | null | undefined,
): string {
  return appendLogLine(appendDeploymentLine(message, deploymentId), logPath);
}

/**
 * Format a server-emitted `event: 'error'` payload with an optional deployment id.
 */
export function formatDeployFailureMessage(
  message: string,
  deploymentId: string | null,
  logPath?: string | null,
): string {
  return appendTrailingLines(message, deploymentId, logPath);
}

/**
 * Format the "stream ended cleanly but no terminal event arrived" case.
 *
 * This is the only call site that should emit the bare "Connection lost during
 * deploy" message — the server closed the NDJSON stream without emitting
 * `done` or `error`, so there is no underlying error to carry.
 */
export function formatConnectionLostMessage(
  deploymentId: string | null,
  logPath?: string | null,
): string {
  return appendTrailingLines('deploy: Connection lost during deploy.', deploymentId, logPath);
}

/**
 * Convert an exception thrown during the deploy NDJSON stream into a
 * user-facing `Error` with a readable message.
 *
 * Three cases:
 *   1. `PlatformApiError` with 409 + a JSON body carrying `{error, deployment}`
 *      — surface the server-supplied error and prefer the body's deployment id.
 *   2. Any other `PlatformApiError` — retain the client's actionable message and
 *      structured error fields; opaque provider failures use a trimmed body snippet.
 *   3. Anything else — preserve the original message under a `Connection lost
 *      during deploy: <original>` prefix so the caller can still tell network,
 *      parse, and transport errors apart.
 */
export function formatStreamDeployError(
  err: unknown,
  deploymentId: string | null,
  logPath?: string | null,
): Error {
  if (err instanceof PlatformApiError) {
    const parsed = parsePlatformErrorBody(err.body);
    const parsedError = platformErrorMessage(parsed) ?? parsed?.error ?? null;
    const parsedDeployment = parsed?.deployment ?? null;
    const effectiveDeploymentId = parsedDeployment ?? deploymentId;

    // cli_outdated: surface the platform's upgrade message verbatim with
    // no "Deploy failed (HTTP 426)" wrapper. The message already includes
    // `npm i -g void@latest`, so adding a status prefix would only obscure
    // the actionable line.
    if (isCliOutdatedError(err) && parsed?.message) {
      err.message = appendTrailingLines(err.message, effectiveDeploymentId, logPath);
      return err;
    }

    if (parsedError || err.status === 401 || err.status === 403 || parsed !== null) {
      err.message = appendTrailingLines(`deploy: ${err.message}`, effectiveDeploymentId, logPath);
      return err;
    }

    const detail = trimSnippet(err.body);
    const base = detail
      ? `deploy: Deploy failed (HTTP ${err.status}): ${detail}`
      : `deploy: Deploy failed (HTTP ${err.status}).`;
    err.message = appendTrailingLines(base, effectiveDeploymentId, logPath);
    return err;
  }

  const original = err instanceof Error ? err.message : String(err);
  return new Error(
    appendTrailingLines(
      `deploy: Connection lost during deploy: '${original}'.`,
      deploymentId,
      logPath,
    ),
  );
}
