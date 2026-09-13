import { intro, outro, log } from '@clack/prompts';
import { getToken } from './auth.ts';
import { PlatformClient, type LogEntry } from './client.ts';
import { cliTitle, dim, pc } from './output.ts';
import { readDeploymentPlatform, readProjectConfig } from './project.ts';

export async function runLogsCommand(
  root: string,
  filter: string,
  range: string,
  deployment?: string,
  level?: string,
): Promise<void> {
  console.log();
  intro(cliTitle('project logs'));

  const platform = readDeploymentPlatform(root);
  if (platform === 'cloudflare') {
    const { resolveCloudflareOperationContext, tailCloudflareWorker } =
      await import('./cloudflare-operations.ts');
    if (range !== '1h') {
      log.warn('Cloudflare tail streams live logs; --range does not select historical entries.');
    }
    if (level && level !== 'all' && level !== 'error') {
      log.warn(
        'Cloudflare tail cannot filter individual console levels; showing all invocation logs.',
      );
    }
    await tailCloudflareWorker(resolveCloudflareOperationContext(root), {
      filter: filter || undefined,
      versionId: deployment || undefined,
      status: level === 'error' ? 'error' : undefined,
    });
    return;
  }
  if (platform === 'none') {
    throw new Error('logs: Deployment is disabled. Run `void init` to choose a platform.');
  }

  const token = getToken(root);
  if (!token) {
    log.error('Not logged in. Run `void auth login` first.');
    process.exit(1);
  }

  if (!/^\d+(m|h|d)$/.test(range)) {
    log.error(`logs: Invalid range '${range}'. Use a format like 15m, 2h, or 3d.`);
    process.exit(1);
  }

  const linked = readProjectConfig(root);
  if (!linked) {
    log.error('No linked project. Run `void project link` first.');
    process.exit(1);
  }

  const client = new PlatformClient(token, { root });

  let entries: Array<LogEntry>;
  try {
    entries = await client.getLogs(
      linked.projectId,
      range,
      200,
      deployment || undefined,
      level || undefined,
    );
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  entries = filterLogEntries(entries, level, filter);

  if (entries.length === 0) {
    outro(`No logs found in the last ${range}.`);
    return;
  }

  for (const entry of entries) {
    printEntry(entry);
  }

  outro(dim(`${entries.length} log entries`));
}

function printEntry(entry: LogEntry): void {
  const time = formatTime(entry.timestamp);
  const method = entry.method || '-';
  const url = entry.url || '-';
  const status = entry.status || '-';

  const statusNum = parseInt(status, 10);
  const coloredStatus =
    entry.outcome === 'exception' || statusNum >= 500
      ? pc.red(status)
      : statusNum >= 400
        ? pc.yellow(status)
        : status;

  console.log(`${dim(time)} ${method} ${url} ${coloredStatus}`);

  for (const l of entry.logs) {
    const text = l.message.map(String).join(' ');
    const level = l.level ?? 'log';
    if (level === 'error') {
      console.log(`  ${pc.red(`[${level}]`)} ${text}`);
    } else if (level === 'warn') {
      console.log(`  ${pc.yellow(`[${level}]`)} ${text}`);
    } else {
      console.log(`  ${dim(`[${level}]`)} ${text}`);
    }
  }

  for (const ex of entry.exceptions) {
    console.log(`  ${pc.red('[exception]')} ${ex.name}: ${ex.message}`);
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

/**
 * Filter log entries by `--level` then by `--filter` substring. Exported for tests.
 *
 * - `level === 'error'`: keep entries with any error-level log line, OR a
 *   non-empty `exceptions[]`, OR `outcome !== 'ok'` (exceptions and non-ok
 *   outcomes are inherently errors).
 * - `level === 'warn' | 'info' | 'log' | 'debug'`: keep entries with at least
 *   one matching log line. Mirrors `journalctl -p` — does NOT include error.
 * - `level` falsy or `'all'`: no level filter.
 *
 * `filter` is a plain substring search over log message text and exception
 * name/message; case-insensitive. Applied after the level filter.
 */
export function filterLogEntries(
  entries: Array<LogEntry>,
  level: string | undefined,
  filter: string | undefined,
): Array<LogEntry> {
  let result = entries;

  if (level && level !== 'all') {
    result = result.filter((entry) => {
      if (level === 'error') {
        if (entry.outcome !== 'ok') {
          return true;
        }
        if (entry.exceptions.length > 0) {
          return true;
        }
        // A 5xx response is an error even when the worker neither threw nor
        // logged (mirrors the server-side `blob6 LIKE '5%'` predicate).
        if (parseInt(entry.status, 10) >= 500) {
          return true;
        }
        for (const l of entry.logs) {
          if (l.level === 'error') {
            return true;
          }
        }
        return false;
      }
      for (const l of entry.logs) {
        // Normalize a missing level to `log` so the filter matches what
        // `printEntry` shows (it falls back to `[log]` for nullish levels).
        if ((l.level ?? 'log') === level) {
          return true;
        }
      }
      return false;
    });
  }

  if (filter) {
    const lower = filter.toLowerCase();
    result = result.filter((entry) => {
      for (const l of entry.logs) {
        const text = l.message.map(String).join(' ');
        if (text.toLowerCase().includes(lower)) {
          return true;
        }
      }
      for (const ex of entry.exceptions) {
        if (ex.name.toLowerCase().includes(lower)) {
          return true;
        }
        if (ex.message.toLowerCase().includes(lower)) {
          return true;
        }
      }
      return false;
    });
  }

  return result;
}
