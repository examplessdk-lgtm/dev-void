import { intro, outro, log } from "@clack/prompts";
import { getToken } from "./auth";
import { PlatformClient, type LogEntry } from "./client";
import { readProjectConfig } from "./project";
import { cliTitle, dim, pc } from "./output";

export async function runLogsCommand(
  root: string,
  filter: string,
  range: string,
  deployment?: string,
): Promise<void> {
  console.log();
  intro(cliTitle("project logs"));

  const token = getToken();
  if (!token) {
    log.error("Not logged in. Run `void auth login` first.");
    process.exit(1);
  }

  if (!/^\d+(m|h|d)$/.test(range)) {
    log.error(`Invalid range "${range}". Use format like 15m, 2h, 3d.`);
    process.exit(1);
  }

  const linked = readProjectConfig(root);
  if (!linked) {
    log.error("No linked project. Run `void project link` first.");
    process.exit(1);
  }

  const client = new PlatformClient(token);

  let entries: LogEntry[];
  try {
    entries = await client.getLogs(linked.projectId, range, 200, deployment || undefined);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (filter) {
    const lower = filter.toLowerCase();
    entries = entries.filter((entry) => {
      for (const l of entry.logs) {
        const text = l.message.map(String).join(" ");
        if (text.toLowerCase().includes(lower)) return true;
      }
      for (const ex of entry.exceptions) {
        if (ex.name.toLowerCase().includes(lower)) return true;
        if (ex.message.toLowerCase().includes(lower)) return true;
      }
      return false;
    });
  }

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
  const method = entry.method || "-";
  const url = entry.url || "-";
  const status = entry.status || "-";

  const statusNum = parseInt(status, 10);
  const coloredStatus =
    entry.outcome === "exception" || statusNum >= 500
      ? pc.red(status)
      : statusNum >= 400
        ? pc.yellow(status)
        : status;

  console.log(`${dim(time)} ${method} ${url} ${coloredStatus}`);

  for (const l of entry.logs) {
    const text = l.message.map(String).join(" ");
    const level = l.level ?? "log";
    if (level === "error") {
      console.log(`  ${pc.red(`[${level}]`)} ${text}`);
    } else if (level === "warn") {
      console.log(`  ${pc.yellow(`[${level}]`)} ${text}`);
    } else {
      console.log(`  ${dim(`[${level}]`)} ${text}`);
    }
  }

  for (const ex of entry.exceptions) {
    console.log(`  ${pc.red("[exception]")} ${ex.name}: ${ex.message}`);
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-GB", { hour12: false });
}
