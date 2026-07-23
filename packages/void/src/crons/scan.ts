import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'pathslash';
import { glob, globSync } from 'tinyglobby';

const JOB_EXTENSIONS = ['ts', 'mts', 'js', 'mjs'];

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
  // Try single string: export const cron = "..."
  const singleMatch = source.match(/export\s+const\s+cron\s*=\s*(['"`])([^'"`]+)\1/);
  if (singleMatch) {
    const cron = singleMatch[2].trim();
    if (!cron) {
      throw new Error(`cron: Invalid job file '${filePath}'. Cron expression cannot be empty.`);
    }
    return [cron];
  }

  // Try array: export const cron = ["...", "..."]
  const arrayMatch = source.match(/export\s+const\s+cron\s*=\s*\[([^\]]+)\]/);
  if (arrayMatch) {
    const items = arrayMatch[1].match(/(['"`])([^'"`]+)\1/g);
    if (!items || items.length === 0) {
      throw new Error(`cron: Invalid job file '${filePath}'. Cron array cannot be empty.`);
    }
    return items.map((item) => {
      const cronMatch = item.match(/['"`]([^'"`]+)['"`]/);
      return cronMatch![1].trim();
    });
  }

  throw new Error(
    `cron: Invalid job file '${filePath}'. Add \`export const cron = "<schedule>"\`.`,
  );
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
  const pattern = `**/*.{${JOB_EXTENSIONS.join(',')}}`;
  const files = await glob(pattern, { cwd: resolveDir(root, jobsDir), absolute: false }).catch(
    () => [] as Array<string>,
  );
  return parseJobFiles(root, jobsDir, files);
}

export function scanJobsSync(root: string, jobsDir = 'crons'): Array<JobDefinition> {
  const pattern = `**/*.{${JOB_EXTENSIONS.join(',')}}`;
  let files: Array<string>;
  try {
    files = globSync(pattern, { cwd: resolveDir(root, jobsDir), absolute: false });
  } catch {
    files = [];
  }
  return parseJobFiles(root, jobsDir, files);
}
