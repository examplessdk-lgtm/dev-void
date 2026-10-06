import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'pathslash';
import { glob, globSync } from 'tinyglobby';
import { staticExportInitializers, staticLiteral } from '../shared/static-exports.ts';

const QUEUE_PATTERN = '**/*.{ts,mts,js,mjs}';

export type QueueDefinition = {
  /** Relative file path from queues/ */
  filePath: string;
  /** Deterministic name (path without extension, with directories joined by `-`) */
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
  return filePath.replace(/\.[^.]+$/, '').replaceAll('/', '-');
}

function deriveQueueBindingName(name: string): string {
  return 'QUEUE_' + name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

const OPTION_NAMES = ['maxBatchSize', 'maxBatchTimeout', 'maxRetries', 'retryDelay'] as const;

function resolveQueuesDir(root: string, queuesDir: string): string {
  return isAbsolute(queuesDir) ? queuesDir : join(root, queuesDir);
}

function parseQueueFiles(queuesDirPath: string, files: Array<string>): Array<QueueDefinition> {
  const definitions = files
    .filter((filePath) => !filePath.split('/').some((segment) => segment.startsWith('_')))
    .sort()
    .map((filePath) => {
      const absPath = join(queuesDirPath, filePath);
      const source = readFileSync(absPath, 'utf-8');
      const name = extractName(filePath);
      const options = OPTION_NAMES.some((option) => source.includes(option))
        ? staticExportInitializers(absPath, source, new Set(OPTION_NAMES))
        : new Map();
      const optionValue = (option: (typeof OPTION_NAMES)[number]): number | undefined => {
        const initializer = options.get(option);
        if (!initializer) {
          return undefined;
        }
        const value = staticLiteral(initializer);
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
          throw new Error(
            `queue: ${option} in '${filePath}' must be a nonnegative integer literal.`,
          );
        }
        return value;
      };
      return {
        filePath,
        name,
        bindingName: deriveQueueBindingName(name),
        maxBatchSize: optionValue('maxBatchSize'),
        maxBatchTimeout: optionValue('maxBatchTimeout'),
        maxRetries: optionValue('maxRetries'),
        retryDelay: optionValue('retryDelay'),
      };
    });

  const filesByName = new Map<string, Array<string>>();
  for (const definition of definitions) {
    const matchingFiles = filesByName.get(definition.name) ?? [];
    matchingFiles.push(definition.filePath);
    filesByName.set(definition.name, matchingFiles);
  }

  const collisions = [...filesByName]
    .filter(([, matchingFiles]) => matchingFiles.length > 1)
    .sort(([leftName], [rightName]) => (leftName < rightName ? -1 : leftName > rightName ? 1 : 0))
    .map(
      ([name, matchingFiles]) =>
        `  ${JSON.stringify(name)}: ${matchingFiles.map((file) => JSON.stringify(file)).join(', ')}`,
    );
  if (collisions.length > 0) {
    throw new Error(
      [
        'queue: Multiple queue files resolve to the same queue name:',
        ...collisions,
        'Rename the conflicting files so each queue has a unique name.',
      ].join('\n'),
    );
  }

  return definitions;
}

export async function scanQueues(
  root: string,
  queuesDir = 'queues',
): Promise<Array<QueueDefinition>> {
  const queuesDirPath = resolveQueuesDir(root, queuesDir);
  const files = await glob(QUEUE_PATTERN, { cwd: queuesDirPath, absolute: false }).catch(
    () => [] as Array<string>,
  );
  return parseQueueFiles(queuesDirPath, files);
}

export function scanQueuesSync(root: string, queuesDir = 'queues'): Array<QueueDefinition> {
  const queuesDirPath = resolveQueuesDir(root, queuesDir);
  let files: Array<string>;
  try {
    files = globSync(QUEUE_PATTERN, { cwd: queuesDirPath, absolute: false });
  } catch {
    files = [];
  }
  return parseQueueFiles(queuesDirPath, files);
}
