import { createServer, type Server } from "node:net";
import { once } from "node:events";
import type { spawn } from "node:child_process";

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
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as import("node:net").AddressInfo;
  server.unref(); // don't block process exit if beforeAll throws before waitForServer
  heldServers.set(port, server);
  return port;
}

export async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  // Release the held port so the child process can bind to it.
  // This is called right after spawn(), minimizing the TOCTOU window.
  const urlPort = Number(new URL(url).port);
  const held = heldServers.get(urlPort);
  if (held) {
    held.close();
    await once(held, "close");
    heldServers.delete(urlPort);
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.status > 0) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for server at ${url}`);
}

export async function killChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
}
