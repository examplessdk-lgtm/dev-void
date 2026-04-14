import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { glob, globSync } from 'tinyglobby';

const QUEUE_EXTENSIONS = ['ts', 'mts', 'js', 'mjs'];

export interface QueueDefinition {
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
}

function extractName(filePath: string): string {
  return filePath.replace(/\.[^.]+$/, '');
}

function deriveBindingName(name: string): string {
  return 'QUEUE_' + name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function extractConsumerOption(source: string, name: string): number | undefined {
  const re = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(\\d+)`);
  const match = source.match(re);
  return match ? Number(match[1]) : undefined;
}

function parseQueueFiles(root: string, queuesDir: string, files: string[]): QueueDefinition[] {
  return files
    .filter((f) => !f.split('/').some((segment) => segment.startsWith('_')))
    .sort((a, b) => a.localeCompare(b))
    .map((filePath) => {
      const absPath = join(root, queuesDir, filePath);
      const source = readFileSync(absPath, 'utf-8');
      const name = extractName(filePath);
      return {
        filePath,
        name,
        bindingName: deriveBindingName(name),
        maxBatchSize: extractConsumerOption(source, 'maxBatchSize'),
        maxBatchTimeout: extractConsumerOption(source, 'maxBatchTimeout'),
        maxRetries: extractConsumerOption(source, 'maxRetries'),
        retryDelay: extractConsumerOption(source, 'retryDelay'),
      };
    });
}

export async function scanQueues(root: string, queuesDir = 'queues'): Promise<QueueDefinition[]> {
  const pattern = `**/*.{${QUEUE_EXTENSIONS.join(',')}}`;
  const files = await glob(pattern, { cwd: `${root}/${queuesDir}`, absolute: false }).catch(
    () => [] as string[],
  );
  return parseQueueFiles(root, queuesDir, files);
}

export function scanQueuesSync(root: string, queuesDir = 'queues'): QueueDefinition[] {
  const pattern = `**/*.{${QUEUE_EXTENSIONS.join(',')}}`;
  let files: string[];
  try {
    files = globSync(pattern, { cwd: `${root}/${queuesDir}`, absolute: false });
  } catch {
    files = [];
  }
  return parseQueueFiles(root, queuesDir, files);
}
