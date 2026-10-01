import { and, eq, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db.ts';
import { projects, projectZeroTrust } from '../schema.ts';
import type { Project } from '../types.ts';
import type { ZeroTrustOperation } from './configuration.ts';

type ProjectCandidate = Readonly<{ project: Project }>;

export function candidateQuery(db: Db) {
  return db
    .select({ project: projects })
    .from(projects)
    .leftJoin(projectZeroTrust, eq(projectZeroTrust.project_id, projects.id));
}

export async function seedCandidates(
  db: Db,
  operation: ZeroTrustOperation,
  initial: boolean,
  limit: number,
): Promise<ReadonlyArray<ProjectCandidate>> {
  const missing = isNull(projectZeroTrust.project_id);
  return candidateQuery(db)
    .where(
      and(
        eq(projects.status, 'active'),
        initial
          ? and(
              lte(projects.created_at, operation.startedAt),
              or(missing, lt(projectZeroTrust.updated_at, operation.startedAt)),
            )
          : missing,
      ),
    )
    .orderBy(projects.created_at, projects.id)
    .limit(limit);
}

/** Marks a project this operation skipped after a project-specific failure. */
export function skippedOperationKey(operation: ZeroTrustOperation): string {
  return `skipped:${operation.id}`;
}

/**
 * A project skipped by this operation keeps its error for the scheduled
 * per-project retry. Selecting it again would stall the operation. Failures
 * that stop the whole operation leave no marker, so a resumed run retries them.
 */
function notSkippedByOperation(operation: ZeroTrustOperation) {
  return sql`${projectZeroTrust.reconciled_operation} IS DISTINCT FROM ${skippedOperationKey(operation)}`;
}

/** Active projects this operation skipped, oldest first. */
export async function skippedProjectIds(
  db: Db,
  operation: ZeroTrustOperation,
  limit: number,
): Promise<ReadonlyArray<string>> {
  const rows = await candidateQuery(db)
    .where(
      and(
        eq(projects.status, 'active'),
        eq(projectZeroTrust.reconciled_operation, skippedOperationKey(operation)),
      ),
    )
    .orderBy(projects.created_at, projects.id)
    .limit(limit);
  return rows.map((row) => row.project.id);
}

/** Make the projects this operation skipped candidates again for its next run. */
export async function retrySkippedProjects(db: Db, operation: ZeroTrustOperation): Promise<void> {
  await db
    .update(projectZeroTrust)
    .set({ reconciled_operation: null })
    .where(eq(projectZeroTrust.reconciled_operation, skippedOperationKey(operation)));
}

export async function publicBypassCandidates(
  db: Db,
  limit: number,
  operation: ZeroTrustOperation,
): Promise<ReadonlyArray<ProjectCandidate>> {
  return candidateQuery(db)
    .where(
      and(
        eq(projects.status, 'active'),
        eq(projectZeroTrust.desired_protected, false),
        notSkippedByOperation(operation),
        or(
          isNull(projectZeroTrust.bypass_application_id),
          sql`${projectZeroTrust.status} <> 'ready'`,
          ...(operation.applicationTarget
            ? [lt(projectZeroTrust.updated_at, operation.startedAt)]
            : []),
        ),
      ),
    )
    .orderBy(projects.created_at, projects.id)
    .limit(limit);
}

export async function reconciliationCandidates(
  db: Db,
  operation: ZeroTrustOperation,
  limit: number,
): Promise<ReadonlyArray<ProjectCandidate>> {
  return candidateQuery(db)
    .where(
      and(
        eq(projects.status, 'active'),
        notSkippedByOperation(operation),
        or(
          isNull(projectZeroTrust.project_id),
          sql`${projectZeroTrust.reconciled_operation} IS DISTINCT FROM ${operation.id}`,
          sql`${projectZeroTrust.status} <> 'ready'`,
          sql`${projectZeroTrust.desired_protected} <> ${projectZeroTrust.effective_protected}`,
        ),
      ),
    )
    .orderBy(projects.created_at, projects.id)
    .limit(limit);
}

export async function disableCandidates(
  db: Db,
  operation: ZeroTrustOperation,
  limit: number,
): Promise<ReadonlyArray<ProjectCandidate>> {
  return candidateQuery(db)
    .where(
      and(
        eq(projects.status, 'active'),
        notSkippedByOperation(operation),
        or(
          isNull(projectZeroTrust.project_id),
          sql`${projectZeroTrust.reconciled_operation} IS DISTINCT FROM ${operation.id}`,
          eq(projectZeroTrust.effective_protected, true),
          eq(projectZeroTrust.desired_protected, true),
          sql`${projectZeroTrust.status} <> 'ready'`,
          sql`${projectZeroTrust.protected_application_id} IS NOT NULL`,
          sql`${projectZeroTrust.protected_application_name} IS NOT NULL`,
        ),
      ),
    )
    .orderBy(projects.created_at, projects.id)
    .limit(limit);
}

export async function bypassCleanupCandidates(
  db: Db,
  operation: ZeroTrustOperation,
  limit: number,
): Promise<ReadonlyArray<ProjectCandidate>> {
  return candidateQuery(db)
    .where(
      and(
        eq(projects.status, 'active'),
        notSkippedByOperation(operation),
        or(
          sql`${projectZeroTrust.bypass_application_id} IS NOT NULL`,
          sql`${projectZeroTrust.bypass_application_name} IS NOT NULL`,
        ),
      ),
    )
    .orderBy(projects.created_at, projects.id)
    .limit(limit);
}
