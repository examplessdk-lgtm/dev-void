import { log } from '@voidzero-dev/vite-plus-prompts';
import { prepareProject } from '../codegen/prepare.ts';
import { printSuccess, note } from './output.ts';

export async function runPrepareCommand(root: string): Promise<void> {
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

  printSuccess('Project codegen is ready.');
}
