import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'pathslash';
import { glob, globSync } from 'tinyglobby';
import {
  staticExportInitializers,
  staticLiteral,
  unwrapStaticExpression,
} from '../shared/static-exports.ts';

const JOB_PATTERN = '**/*.{ts,mts,js,mjs}';

export type JobDefinition = {
  /** Relative file path from jobs/ */
  filePath: string;
  /** Deterministic job name (path without extension) */
  name: string;
  /** Cron expressions from `export const cron = "..."` or `export const cron = ["...", "..."]` */
  crons: Array<string>;
};

function extractJobName(filePath: string): string {
  return filePath.replace(/\.[^.]+$/, '');
}

function extractCronExpressions(source: string, filePath: string): Array<string> {
  const initializer = unwrapStaticExpression(
    staticExportInitializers(filePath, source, new Set(['cron'])).get('cron'),
  );
  if (!initializer) {
    throw new Error(
      `cron: Invalid job file '${filePath}'. Add \`export const cron = "<schedule>"\`.`,
    );
  }
  const values =
    initializer.type === 'ArrayExpression'
      ? ((initializer.elements as Array<import('../shared/ast.ts').AstNode | null> | undefined) ??
        [])
      : [initializer];
  if (values.length === 0) {
    throw new Error(`cron: Invalid job file '${filePath}'. Cron array cannot be empty.`);
  }
  return values.map((value) => {
    const cron = staticLiteral(value ?? undefined);
    if (typeof cron !== 'string' || !cron.trim()) {
      throw new Error(
        `cron: Invalid job file '${filePath}'. Cron expression must be a nonempty string literal.`,
      );
    }
    return cron.trim();
  });
}

function resolveDir(root: string, dir: string): string {
  return isAbsolute(dir) ? dir : join(root, dir);
}

function parseJobFiles(root: string, jobsDir: string, files: Array<string>): Array<JobDefinition> {
  const jobsDirPath = resolveDir(root, jobsDir);
  return files
    .filter((filePath) => !filePath.split('/').some((segment) => segment.startsWith('_')))
    .sort((leftFilePath, rightFilePath) => leftFilePath.localeCompare(rightFilePath))
    .map((filePath) => {
      const absPath = join(jobsDirPath, filePath);
      const source = readFileSync(absPath, 'utf-8');
      return {
        filePath,
        name: extractJobName(filePath),
        crons: extractCronExpressions(source, filePath),
      };
    });
}

export async function scanJobs(root: string, jobsDir = 'crons'): Promise<Array<JobDefinition>> {
  const files = await glob(JOB_PATTERN, { cwd: resolveDir(root, jobsDir), absolute: false }).catch(
    () => [] as Array<string>,
  );
  return parseJobFiles(root, jobsDir, files);
}

export function scanJobsSync(root: string, jobsDir = 'crons'): Array<JobDefinition> {
  let files: Array<string>;
  try {
    files = globSync(JOB_PATTERN, { cwd: resolveDir(root, jobsDir), absolute: false });
  } catch {
    files = [];
  }
  return parseJobFiles(root, jobsDir, files);
}
