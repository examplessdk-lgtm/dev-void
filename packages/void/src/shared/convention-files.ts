import { globSync } from 'tinyglobby';

/** Handler files under `dir`, relative to it, skipping paths with a `_`-prefixed segment. */
export function listConventionFiles(dir: string): Array<string> {
  return globSync('**/*.{ts,mts,js,mjs}', { cwd: dir }).filter(
    (filePath) => !filePath.split('/').some((segment) => segment.startsWith('_')),
  );
}
