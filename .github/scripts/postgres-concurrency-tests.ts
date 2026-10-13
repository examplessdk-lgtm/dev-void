import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports -- Native filesystem paths are never embedded in source.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'vite';
import { isRecord } from '../../packages/deploy-core/src/is-record.ts';
import { compatibilityTestFiles } from './schema-compat-tests.ts';

function memberName(node: unknown): string | undefined {
  if (!isRecord(node) || node.type !== 'MemberExpression' || !isRecord(node.property)) {
    return undefined;
  }
  if (!node.computed && node.property.type === 'Identifier') {
    return typeof node.property.name === 'string' ? node.property.name : undefined;
  }
  return node.computed && typeof node.property.value === 'string' ? node.property.value : undefined;
}

function usesPostgresEnvironment(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some(usesPostgresEnvironment);
  }
  if (!isRecord(node)) {
    return false;
  }
  if (
    memberName(node) === 'VOID_TEST_DATABASE_URL' &&
    isRecord(node.object) &&
    memberName(node.object) === 'env' &&
    isRecord(node.object.object) &&
    node.object.object.type === 'Identifier' &&
    node.object.object.name === 'process'
  ) {
    return true;
  }
  return Object.values(node).some(usesPostgresEnvironment);
}

/** Select real PostgreSQL cases without repeating the whole in-memory API suite. */
function postgresConcurrencyTestFiles(root: string): Array<string> {
  const files = compatibilityTestFiles(root).filter((file) => {
    const parsed = parseSync(file, readFileSync(join(root, file), 'utf8'));
    if (parsed.errors.length > 0) {
      throw new Error(`Cannot inspect PostgreSQL test coverage in ${file}.`);
    }
    return usesPostgresEnvironment(parsed.program);
  });
  if (files.length === 0) {
    throw new Error('No PostgreSQL concurrency test files were found.');
  }
  return files;
}

const files = postgresConcurrencyTestFiles(process.cwd());
// Reuse the bounded runner's independent database clones and cleanup for every file.
const result = spawnSync(
  process.execPath,
  [fileURLToPath(new URL('./schema-compat-tests.ts', import.meta.url)), ...files],
  { stdio: 'inherit' },
);
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
