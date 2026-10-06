import { execSync, type spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { basename, join, relative } from 'node:path/posix';

/**
 * Timeout multiplier for Windows CI runners, which are 2–3× slower
 * for builds and server startup.
 */
const CI_TIMEOUT_SCALE = process.platform === 'win32' ? 3 : 1;

/**
 * Ports held by getPort() until waitForServer() releases them.
 * Prevents TOCTOU races when many integration tests run in parallel —
 * without this, another test's getPort() can grab the same port
 * during the gap between close and the child process's listen().
 */
const heldServers = new Map<number, Server>();

const GENERATED_PLAYGROUND_ENTRIES = new Set([
  '.astro',
  '.next',
  '.nuxt',
  '.output',
  '.react-router',
  '.svelte-kit',
  '.tanstack',
  '.void',
  '.vite-cloud',
  '.wrangler',
  'build',
  'dist',
  'node_modules',
]);

export type IsolatedPlayground = {
  root: string;
  workspacePath: string;
  cleanup: () => void;
};

export function shouldCopyPlaygroundPath(sourceRoot: string, path: string): boolean {
  const normalizedSourceRoot = sourceRoot.replaceAll('\\', '/');
  const normalizedPath = path.replaceAll('\\', '/');
  const relativePath = relative(normalizedSourceRoot, normalizedPath);
  const topLevelEntry = relativePath.split('/')[0];
  return relativePath === '' || !GENERATED_PLAYGROUND_ENTRIES.has(topLevelEntry);
}

/**
 * Copies a playground outside the workspace package globs so concurrent task-graph scans never
 * discover a manifest while the fixture is created or removed. Run Vite+ directly from the copy.
 * Dependencies stay linked to the installed source tree; generated state is deliberately not copied.
 */
export function createIsolatedPlayground(
  workspaceRoot: string,
  sourceWorkspacePath: string,
): IsolatedPlayground {
  const sourceRoot = join(workspaceRoot, sourceWorkspacePath);
  const snapshot = process.env.VOID_TEST_SOURCE_SNAPSHOTS
    ? join(process.env.VOID_TEST_SOURCE_SNAPSHOTS, sourceWorkspacePath)
    : undefined;
  const copySource = snapshot && existsSync(snapshot) ? snapshot : sourceRoot;
  const playgroundLocal = join(workspaceRoot, 'playground-local', '.test-fixtures');
  mkdirSync(playgroundLocal, { recursive: true });
  const root = mkdtempSync(join(playgroundLocal, `test-${basename(sourceWorkspacePath)}-`));

  cpSync(copySource, root, {
    recursive: true,
    filter(path) {
      // `cpSync` reports native backslash paths on Windows, while these workspace paths are
      // normalized to forward slashes. Normalize before using the POSIX path helpers or the
      // top-level `node_modules` directory is copied into the isolated dependency tree.
      return shouldCopyPlaygroundPath(copySource, path);
    },
  });

  const sourceNodeModules = join(sourceRoot, 'node_modules');
  if (existsSync(sourceNodeModules)) {
    const fixtureNodeModules = join(root, 'node_modules');
    mkdirSync(fixtureNodeModules);
    const linkDependency = (source: string, destination: string) =>
      symlinkSync(
        realpathSync(source),
        destination,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    // Linking the whole directory leaves pnpm's relative package links behind
    // a Windows junction at a different depth. Pin each package's real target.
    for (const entry of readdirSync(sourceNodeModules, { withFileTypes: true })) {
      // Kit 3 writes project-specific generated configs here, not package dependencies.
      if (entry.name === '$app') {
        continue;
      }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }
      if (entry.name.startsWith('.') && entry.name !== '.bin') {
        continue;
      }
      const source = join(sourceNodeModules, entry.name);
      const destination = join(fixtureNodeModules, entry.name);
      if (entry.name.startsWith('@')) {
        mkdirSync(destination);
        for (const name of readdirSync(source)) {
          linkDependency(join(source, name), join(destination, name));
        }
      } else {
        linkDependency(source, destination);
      }
    }
  }

  // Avoid duplicate workspace package names when multiple copies exist concurrently.
  const packagePath = join(root, 'package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8')) as { name?: string };
  packageJson.name = `${packageJson.name ?? basename(sourceWorkspacePath)}-${basename(root)}`;
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  return {
    root,
    workspacePath: relative(workspaceRoot, root),
    cleanup() {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    },
  };
}

/**
 * Returns an unused port by binding to port 0 and reading the
 * OS-assigned port. The underlying socket stays open until
 * waitForServer() is called with a URL on that port, preventing
 * other parallel tests from stealing it.
 */
export async function getPort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as import('node:net').AddressInfo;
  server.unref(); // don't block process exit if beforeAll throws before waitForServer
  heldServers.set(port, server);
  return port;
}

export async function waitForServer(
  url: string,
  timeoutMs: number,
  options?: {
    expectBody?: string;
    rejectBody?: string;
    expectStatus?: number;
    isAlive?: () => boolean;
    requestTimeoutMs?: number;
    diagnostics?: () => string;
  },
): Promise<void> {
  // Release the held port so the child process can bind to it.
  // This is called right after spawn(), minimizing the TOCTOU window.
  const urlPort = Number(new URL(url).port);
  const held = heldServers.get(urlPort);
  if (held) {
    held.close();
    await once(held, 'close');
    heldServers.delete(urlPort);
  }

  const effectiveTimeout = timeoutMs * CI_TIMEOUT_SCALE;
  const start = Date.now();
  while (Date.now() - start < effectiveTimeout) {
    if (options?.isAlive && !options.isAlive()) {
      throw new Error(
        `Server process exited while waiting for ${url}\n${options.diagnostics?.() ?? ''}`,
      );
    }
    try {
      const remainingMs = effectiveTimeout - (Date.now() - start);
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.min(options?.requestTimeoutMs ?? 5_000, remainingMs)),
      });
      const statusMatches =
        options?.expectStatus === undefined
          ? response.status > 0
          : response.status === options.expectStatus;
      if (statusMatches) {
        if (!options?.expectBody && !options?.rejectBody) {
          return;
        }
        const body = await response.text();
        if (
          (!options.expectBody || body.includes(options.expectBody)) &&
          (!options.rejectBody || !body.includes(options.rejectBody))
        ) {
          return;
        }
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Timed out waiting for server at ${url} (waited ${effectiveTimeout}ms, scale=${CI_TIMEOUT_SCALE})\n${options?.diagnostics?.() ?? ''}`,
  );
}

/** Drain both pipes during startup and retain bounded diagnostics for failures. */
export function collectServerOutput(child: ReturnType<typeof spawn>): () => string {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout = (stdout + String(chunk)).slice(-16000);
  });
  child.stderr?.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-16000);
  });
  return () => `Server stdout:\n${stdout}\nServer stderr:\n${stderr}`;
}

export async function killChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32' && child.pid) {
      // On Windows, SIGTERM doesn't propagate to child processes.
      // Use taskkill /T to kill the entire process tree (e.g. workerd.exe).
      try {
        execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
      } catch {
        // Process may have already exited
      }
    } else if (child.pid) {
      // On Unix, SIGTERM only reaches the direct child (e.g. pnpm).
      // Grandchildren like vite → miniflare → workerd are NOT signalled
      // and become orphans that hold resource locks (D1 SQLite, ports).
      // Walk the process tree bottom-up so every descendant is killed.
      killTree(child.pid, 'SIGTERM');
    } else {
      child.kill('SIGTERM');
    }
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        once(child, 'exit'),
        new Promise((resolve) => {
          deadline = setTimeout(resolve, 5_000);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform !== 'win32' && child.pid) {
        killTree(child.pid, 'SIGKILL');
      } else {
        child.kill('SIGKILL');
      }
    }
  }
}

function killTree(pid: number, signal: NodeJS.Signals): void {
  // Find direct children before killing the parent, because once the
  // parent dies its children are reparented to init and pgrep -P won't
  // find them anymore.
  let childPids: Array<number> = [];
  try {
    childPids = execSync(`pgrep -P ${pid}`, { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    // pgrep exits 1 when no children are found
  }
  for (const childPid of childPids) {
    killTree(childPid, signal);
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Process may have already exited
  }
}
