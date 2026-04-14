import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

function sendRpc(proc: ChildProcess, request: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.stdout!.off('data', onData);
      reject(new Error('MCP response timeout'));
    }, 5000);

    let buffer = '';

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      proc.stdout!.off('data', onData);
      clearTimeout(timer);
      resolve(JSON.parse(line));
    };

    proc.stdout!.on('data', onData);
    proc.stdin!.write(JSON.stringify(request) + '\n');
  });
}

describe('mcp dist build', () => {
  it('responds to initialize from dist entry', async () => {
    const cli = join(import.meta.dirname, '../../dist/cli/cli.mjs');
    const proc = spawn('node', [cli, 'mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    try {
      const res = await sendRpc(proc, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      });
      const result = res.result as Record<string, unknown>;
      const serverInfo = result.serverInfo as Record<string, unknown>;
      expect(serverInfo.name).toBe('void');
    } finally {
      proc.kill();
    }
  });

  it('lists doc pages from dist build', async () => {
    const cli = join(import.meta.dirname, '../../dist/cli/cli.mjs');
    const proc = spawn('node', [cli, 'mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    try {
      // initialize first
      await sendRpc(proc, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      });
      // list pages
      const res = await sendRpc(proc, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'list_pages', arguments: {} },
      });
      const result = res.result as {
        content: { type: string; text: string }[];
      };
      const pages = JSON.parse(result.content[0].text);
      expect(pages.length).toBeGreaterThan(0);
      expect(pages[0]).toHaveProperty('slug');
    } finally {
      proc.kill();
    }
  });
});
