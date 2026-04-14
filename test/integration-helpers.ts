import { execSync, type spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:net';

/**
 * Ports held by getPort() until waitForServer() releases them.
 * Prevents TOCTOU races when many integration tests run in parallel —
 * without this, another test's getPort() can grab the same port
 * during the gap between close and the child process's listen().
 */
const heldServers = new Map<number, Server>();

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
  options?: { expectBody?: string; isAlive?: () => boolean },
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

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (options?.isAlive && !options.isAlive()) {
      throw new Error(`Server process exited while waiting for ${url}`);
    }
    try {
      const response = await fetch(url);
      if (response.status > 0) {
        if (!options?.expectBody) {
          return;
        }
        const body = await response.text();
        if (body.includes(options.expectBody)) {
          return;
        }
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for server at ${url}`);
}

export async function killChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32' && child.pid) {
      // On Windows, SIGTERM doesn't propagate to child processes.
      // Use taskkill /T to kill the entire process tree (e.g. workerd.exe).
      // See: https://github.com/voidzero-dev/void/actions/runs/23939152784/job/69826006981?pr=63
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
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
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
  let childPids: number[] = [];
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
