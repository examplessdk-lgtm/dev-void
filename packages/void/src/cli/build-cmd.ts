import { appendFileSync } from 'node:fs';
import { intro, log, outro } from '@clack/prompts';
import { getToken } from './auth.ts';
import type { BuildArgs } from './build-args.ts';
import { PlatformApiError, PlatformClient, type BuildLogsResponse } from './client.ts';
import { cliTitle, dim, pc } from './output.ts';
import { readProjectConfig } from './project.ts';
import { getRequestedProjectSlug, resolveProjectBySlug } from './resolve-project.ts';

const POLL_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pure follow-loop: repeatedly fetch pages since a cursor, write each new
 * line, and stop when the build reaches a terminal status. `fetchPage`,
 * `write`, and `sleep` are injected so this is unit-testable. Returns the
 * final status + terminal flag.
 */
export async function followBuildLogs(opts: {
  fetchPage: (since: number) => Promise<BuildLogsResponse>;
  write: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  since: number;
  status: string;
  pollMs?: number;
}): Promise<{ status: string; terminal: boolean }> {
  let cursor = opts.since;
  let status = opts.status;
  const pollMs = opts.pollMs ?? POLL_MS;
  for (;;) {
    await opts.sleep(pollMs);
    const pageResult = await opts.fetchPage(cursor);
    for (const l of pageResult.lines) {
      opts.write(l.line);
    }
    cursor = pageResult.lastSeq;
    status = pageResult.status;
    if (pageResult.terminal) {
      return { status, terminal: true };
    }
  }
}

export async function runBuildCommand(root: string, args: BuildArgs): Promise<void> {
  if (args.subcommand === 'logs') {
    return runBuildLogsCommand(root, args);
  }
}

async function runBuildLogsCommand(
  root: string,
  args: Extract<BuildArgs, { subcommand: 'logs' }>,
): Promise<void> {
  console.log();
  intro(cliTitle('build logs'));

  const token = getToken(root);
  if (!token) {
    log.error('Not logged in. Run `void auth login` first.');
    process.exit(1);
  }

  const client = new PlatformClient(token, { root });

  // Resolve project: --project/positional slug -> VOID_PROJECT -> linked config.
  let projectId: string;
  const requestedSlug = getRequestedProjectSlug({ projectSlug: args.projectName });
  if (requestedSlug) {
    const projects = await client.listProjects();
    const resolved = resolveProjectBySlug(projects, requestedSlug);
    if (!resolved) {
      log.error(`build: No project found with slug '${requestedSlug}'.`);
      process.exit(1);
    }
    projectId = resolved.projectId;
  } else {
    const linked = readProjectConfig(root);
    if (!linked) {
      log.error(
        'build: No project specified. Pass a project with --project <slug>, set VOID_PROJECT, or link one with `void project link`.',
      );
      process.exit(1);
    }
    projectId = linked.projectId;
  }

  // Resolve build: explicit id or the newest build.
  let buildId = args.buildId;
  if (!buildId) {
    const builds = await client.listBuilds(projectId, 1);
    if (builds.length === 0) {
      outro('No builds found. Push to your connected branch to trigger one.');
      return;
    }
    buildId = builds[0]!.id;
  }

  // Writer: append to a file, or print to stdout.
  const write = args.output
    ? (line: string): void => appendFileSync(args.output!, `${line}\n`)
    : (line: string): void => console.log(line);

  // First page (since=0).
  let first: BuildLogsResponse;
  try {
    first = await client.getBuildLogs(projectId, buildId, 0);
  } catch (err) {
    if (err instanceof PlatformApiError && err.status === 404) {
      log.error(`build: Build '${buildId}' not found for this project.`);
      process.exit(1);
    }
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // github_actions builds keep their logs on GitHub.
  if (first.external) {
    log.message(`This build ran on GitHub Actions. View logs:\n${pc.cyan(first.external)}`);
    return;
  }

  for (const l of first.lines) {
    write(l.line);
  }

  let status = first.status;
  let terminal = first.terminal;

  if (args.follow && !terminal) {
    ({ status, terminal } = await followBuildLogs({
      fetchPage: (since) => client.getBuildLogs(projectId, buildId!, since),
      write,
      sleep,
      since: first.lastSeq,
      status,
    }));
  }

  if (!terminal) {
    outro(dim('Build still running — pass -f to follow.'));
    return;
  }

  outro(dim(`Build ${status}.`));
}
