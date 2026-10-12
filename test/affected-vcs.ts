import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

type VcsOptions = { root: string; changedSince?: string | boolean };
type AffectedVcsProvider = {
  findChangedFiles(options: VcsOptions): Promise<Array<string>>;
  addRelatedFiles(files: Array<string>): void;
};
const execFileAsync = promisify(execFile);

async function changedFiles(root: string, base?: string): Promise<Array<string>> {
  const git = async (args: Array<string>): Promise<string> => {
    const { stdout } = await execFileAsync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  };
  const revision = base ? (await git(['merge-base', base, 'HEAD'])).trim() : undefined;
  const outputs = await Promise.all([
    revision ? git(['diff', '--name-only', '-z', '--no-renames', revision, 'HEAD', '--']) : '',
    git(['diff', '--name-only', '-z', '--no-renames', '--cached', 'HEAD', '--']),
    git(['diff', '--name-only', '-z', '--no-renames', '--']),
    git(['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  return [...new Set(outputs.flatMap((output) => output.split('\0')).filter(Boolean))].sort();
}

export function createAffectedVcsProvider(): AffectedVcsProvider {
  const snapshots = new Map<string, Promise<Array<string>>>();
  const related = new Set<string>();
  return {
    async findChangedFiles({ root, changedSince }) {
      const base = typeof changedSince === 'string' ? changedSince : undefined;
      const key = JSON.stringify([resolve(root), base]);
      let snapshot = snapshots.get(key);
      if (!snapshot) {
        snapshot = changedFiles(root, base).then((files) =>
          files.map((file) => resolve(root, file).replaceAll('\\', '/')),
        );
        snapshots.set(key, snapshot);
      }
      return [...new Set([...(await snapshot), ...related])];
    },
    addRelatedFiles(files) {
      files.forEach((file) => related.add(resolve(file).replaceAll('\\', '/')));
    },
  };
}
