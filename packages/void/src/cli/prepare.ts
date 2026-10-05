import { log, outro } from '@voidzero-dev/vite-plus-prompts';
import { prepareProject } from '../codegen/prepare.ts';
import { note } from './output.ts';
import type { PrepareArgs } from './prepare-args.ts';

export async function runPrepareCommand(root: string, _args: PrepareArgs): Promise<void> {
  console.log();

  const result = await prepareProject(root);

  if (result.written.length > 0) {
    note(result.written.join('\n'), 'Wrote');
  }
  if (result.removed.length > 0) {
    note(result.removed.join('\n'), 'Removed stale files');
  }

  if (result.written.length === 0 && result.removed.length === 0) {
    log.info('No generated files changed.');
  }

  outro('Project codegen is ready.');
}
