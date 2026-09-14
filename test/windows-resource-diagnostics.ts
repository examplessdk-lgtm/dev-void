import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Best-effort, once-per-file diagnostics: never replace the original test failure. */
export function createWindowsResourceReporter(): () => Promise<void> {
  let snapshot: Promise<void> | undefined;
  return () => {
    snapshot ??= new Promise<string>((resolve) => {
      const finish = (error: Error | null, stdout = '', stderr = '') => {
        resolve(
          [
            'Windows resource snapshot:',
            stdout,
            stderr,
            error ? `Snapshot incomplete: ${error.message}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      };
      try {
        execFile(
          'powershell.exe',
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-File',
            fileURLToPath(new URL('./windows-resource-diagnostics.ps1', import.meta.url)),
          ],
          { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true },
          finish,
        );
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    }).then((output) => {
      console.error(output);
    });
    return snapshot;
  };
}
