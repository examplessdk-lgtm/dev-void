import { readFileSync } from 'node:fs';
import { join } from 'pathslash';
import { listConventionFiles } from '../shared/convention-files.ts';
import { staticExportInitializers, staticLiteral } from '../shared/static-exports.ts';

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

export function scanQueuesSync(queuesDir: string): Array<QueueDefinition> {
  const definitions = listConventionFiles(queuesDir)
    .sort()
    .map((filePath) => {
      const absPath = join(queuesDir, filePath);
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
