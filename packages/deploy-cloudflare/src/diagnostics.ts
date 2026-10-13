import { stripVTControlCharacters } from 'node:util';
import type { CloudflareCommandResult } from './execute.ts';

const MAX_DIAGNOSTIC_LENGTH = 4096;
const MAX_DIAGNOSTIC_LINES = 24;

/** Keep the uploader's error, excluding stdout binding tables and redacting common credential formats. */
export function cloudflareCommandDiagnostic(result: CloudflareCommandResult): string | undefined {
  const stderr = stripVTControlCharacters(result.stderr).replace(/\r\n?/g, '\n');
  const stdout = stripVTControlCharacters(result.stdout).replace(/\r\n?/g, '\n');
  let message = result.error || stderr;
  for (const output of [stderr, stdout]) {
    const marker = /(?:^|\n)[ \t]*(?:[✘×X][ \t]+)?\[ERROR\]\s*/i.exec(output);
    if (marker) {
      message = output.slice(marker.index + marker[0].length);
      break;
    }
  }
  if (message === stderr && !/(?:^|\n)[ \t]*(?:[✘×X][ \t]+)?\[ERROR\]/i.test(stderr)) {
    // cf renders API failures as a box on stdout while config warnings go to
    // stderr. Only copy the error box; stdout may also contain binding values.
    const box =
      /(?:^|\n)[ \t]*┌[ \t]*(?:APIError|Error)\b[^\n]*\n(?:[ \t]*│[^\n]*\n)*[ \t]*└[^\n]*/i.exec(
        stdout,
      );
    if (box) {
      message = box[0].trim();
    } else {
      const lines = stdout.split('\n');
      const abort = lines.find((line) =>
        line.startsWith('■  Aborting the upload operation because of conflicts.'),
      );
      if (abort) {
        const reason = 'You are about to upload a Worker that was last updated via the script API.';
        message = [lines.includes(`▲  ${reason}`) ? reason : '', abort.slice('■  '.length)]
          .filter(Boolean)
          .join('\n');
      }
    }
  }
  // Upload progress and bindings are printed on stdout. Never echo that whole stream
  // when no error block was found, even when the process failed without stderr.
  message = stripVTControlCharacters(message)
    .split(/\n\s*(?:🪵|Logs (?:were )?written|If you think this is a bug)/)[0]!
    .trim();
  if (!message) {
    return undefined;
  }

  message = message
    .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 [redacted]')
    .replace(
      /([?&](?:X-Amz-[A-Za-z0-9-]+|signature|sig|token|access_token|key)=)[^&\s]+/gi,
      '$1[redacted]',
    )
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]*@/gi, '$1[redacted]@')
    .replace(
      /(\b(?:CLOUDFLARE_API_TOKEN|CF_ACCESS_CLIENT_SECRET|access_token|refresh_token|api[_-]?(?:key|token)|password|secret)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[redacted]',
    );
  const bounded = message
    .split('\n')
    .slice(0, MAX_DIAGNOSTIC_LINES)
    .join('\n')
    .slice(0, MAX_DIAGNOSTIC_LENGTH);
  return bounded.length < message.length ? `${bounded}\n[diagnostic truncated]` : bounded;
}
