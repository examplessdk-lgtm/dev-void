import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'pathslash';
import { glob, globSync } from 'tinyglobby';

const QUEUE_EXTENSIONS = ['ts', 'mts', 'js', 'mjs'];

export type QueueDefinition = {
  /** Relative file path from queues/ */
  filePath: string;
  /** Deterministic name (path without extension) */
  name: string;
  /** Binding name: QUEUE_ + uppercased name */
  bindingName: string;
  /** Optional max batch size for consumer */
  maxBatchSize?: number;
  /** Optional max batch timeout (seconds) for consumer */
  maxBatchTimeout?: number;
  /** Optional max retries before dead-lettering */
  maxRetries?: number;
  /** Optional delay (seconds) between retries */
  retryDelay?: number;
};

function extractName(filePath: string): string {
  return filePath.replace(/\.[^.]+$/, '');
}

export function deriveQueueBindingName(name: string): string {
  return 'QUEUE_' + name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function extractConsumerOption(source: string, name: string): number | undefined {
  const optionRe = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(\\d+)`);
  const match = source.match(optionRe);
  return match ? Number(match[1]) : undefined;
}

function parseQueueFiles(
  root: string,
  queuesDir: string,
  files: Array<string>,
): Array<QueueDefinition> {
  const queuesDirPath = isAbsolute(queuesDir) ? queuesDir : join(root, queuesDir);
  return files
    .filter((filePath) => !filePath.split('/').some((segment) => segment.startsWith('_')))
    .sort((leftFilePath, rightFilePath) => leftFilePath.localeCompare(rightFilePath))
    .map((filePath) => {
      const absPath = join(queuesDirPath, filePath);
      const source = readFileSync(absPath, 'utf-8');
      const name = extractName(filePath);
      return {
        filePath,
        name,
        bindingName: deriveQueueBindingName(name),
        maxBatchSize: extractConsumerOption(source, 'maxBatchSize'),
        maxBatchTimeout: extractConsumerOption(source, 'maxBatchTimeout'),
        maxRetries: extractConsumerOption(source, 'maxRetries'),
        retryDelay: extractConsumerOption(source, 'retryDelay'),
      };
    });
}

export async function scanQueues(
  root: string,
  queuesDir = 'queues',
): Promise<Array<QueueDefinition>> {
  const pattern = `**/*.{${QUEUE_EXTENSIONS.join(',')}}`;
  const queuesDirPath = isAbsolute(queuesDir) ? queuesDir : join(root, queuesDir);
  const files = await glob(pattern, { cwd: queuesDirPath, absolute: false }).catch(
    () => [] as Array<string>,
  );
  return parseQueueFiles(root, queuesDir, files);
}

export function scanQueuesSync(root: string, queuesDir = 'queues'): Array<QueueDefinition> {
  const pattern = `**/*.{${QUEUE_EXTENSIONS.join(',')}}`;
  let files: Array<string>;
  try {
    const queuesDirPath = isAbsolute(queuesDir) ? queuesDir : join(root, queuesDir);
    files = globSync(pattern, { cwd: queuesDirPath, absolute: false });
  } catch {
    files = [];
  }
  return parseQueueFiles(root, queuesDir, files);
}
