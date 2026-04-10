export interface MigrationFile {
  name: string;
  sql: string;
  destructive: boolean;
}

/**
 * Destructive SQL patterns that are rejected unless the migration
 * contains the `-- void:allow-destructive` pragma comment.
 */
const DESTRUCTIVE_PATTERNS = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bALTER\s+TABLE\s+\S+\s+RENAME\b/i,
  /\bTRUNCATE\b/i,
];

const PRAGMA_COMMENT = '-- void:allow-destructive';

/**
 * Check if a SQL migration contains destructive operations.
 */
export function isDestructive(sql: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(sql));
}

/**
 * Validate migration files. Returns the validated list with destructive flags.
 * Throws if any destructive migration lacks the allow-destructive pragma.
 */
export function validateMigrations(files: { name: string; sql: string }[]): MigrationFile[] {
  const results: MigrationFile[] = [];
  const errors: string[] = [];

  for (const file of files) {
    const destructive = isDestructive(file.sql);
    if (destructive && !file.sql.includes(PRAGMA_COMMENT)) {
      errors.push(file.name);
    }
    results.push({ name: file.name, sql: file.sql, destructive });
  }

  if (errors.length > 0) {
    throw new Error(
      `Destructive migrations detected without pragma:\n` +
        errors.map((f) => `  - ${f}`).join('\n') +
        `\n\nAdd "${PRAGMA_COMMENT}" to each file to allow the migration locally and on deploy.`,
    );
  }

  return results;
}
