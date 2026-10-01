/**
 * Shared types for the remote build orchestration path (BuildScheduler DO →
 * BuildManager DO → build container). Kept in a standalone module so the
 * scheduler, manager, container agent contract, and tests all reference one
 * source of truth without dragging in DO/Container runtime imports.
 */

/**
 * Everything the BuildManager needs to start a container build for one queued
 * build. Assembled by the scheduler from the build row, owning user, project,
 * and github connection, then handed to `BuildManager.startBuild()` over RPC.
 */
export type BuildConfig = {
  buildId: string;
  projectId: string;
  projectSlug: string;
  userId: string;
  login: string;
  commitSha: string;
  branch: string;
  repoFullName: string;
  installationId: string;
  /**
   * Exact connection row authorized at enqueue. The final authority check
   * cancels the build when it is missing.
   */
  connectionId: string;
  /**
   * The connection's immutable numeric GitHub repository id (as text). Carried
   * so `BuildManager.startBuild` can re-verify the App installation still
   * covers this repo at token-mint time; a missing id fails that check closed.
   * Sourced from the github connection bound to this build (the build row
   * itself does not store a repository id).
   */
  repositoryId: string | null;
  instanceType: string;
  timeoutMinutes: number;
};

/**
 * One line of build output, streamed from the container agent to the
 * BuildManager `POST /logs` endpoint, persisted in the DO's SQLite log table,
 * and fanned out to any attached WebSocket consumers.
 */
export type BuildLogLine = {
  line: string;
  stream: 'stdout' | 'stderr';
  ts: number;
  /** Exact delimiter captured after `line`; absent rows predate delimiter capture. */
  lineEnding?: 'cr' | 'lf' | 'crlf' | 'none';
};

/**
 * The capacity-exhaustion error thrown by `@cloudflare/containers` when a
 * BuildManager fleet is at its `max_instances` cap. There are two independent
 * fleets — base `BUILD_MANAGER` (free) and `BUILD_MANAGER_LARGE` (paid) — each
 * with its own cap, so capacity is per-fleet, not global. This is the library's
 * own public contract (it matches the same substring in `isNoInstanceError`), so
 * classifying on it is as reliable as the library's own retry logic. A capacity
 * failure is transient platform pressure, NOT a build failure — the build should
 * be requeued, not failed.
 */
const NO_CONTAINER_INSTANCE_ERROR =
  'there is no container instance that can be provided to this durable object';

export function isContainerCapacityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes(NO_CONTAINER_INSTANCE_ERROR);
}
