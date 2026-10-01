import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { CloudEnv } from 'void/handler';
import { kitchenSinkSourceFixture } from './kitchen-sink-source-fixture.ts';

const mocks = vi.hoisted(() => ({ getSandbox: vi.fn() }));
vi.mock('void', async () => import('void/handler'));
vi.mock('void/sandbox', () => ({
  getSandbox: mocks.getSandbox,
  SandboxLimitError: class extends Error {},
}));

let fixture: ReturnType<typeof kitchenSinkSourceFixture>;
let app: Hono<CloudEnv>;
beforeAll(async () => {
  fixture = kitchenSinkSourceFixture(['routes/api/sandbox.ts', 'lib/sandbox-demo.ts']);
  const { POST } = await import(join(fixture.root, 'routes/api/sandbox.ts'));
  app = new Hono<CloudEnv>().post('/', (c) => POST(c) as Promise<Response>);
});
afterAll(() => fixture?.cleanup());
const request = (marker: string) =>
  app.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: marker }),
  });

beforeEach(() => mocks.getSandbox.mockReset());

describe('kitchen-sink Sandbox requests', () => {
  it('isolates simultaneous programs and destroys both containers after reading their results', async () => {
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const containers = new Map<string, ReturnType<typeof createContainer>>();
    function createContainer() {
      const files = new Map<string, string>();
      return {
        files: {
          mkdir: vi.fn(),
          writeFile: async (path: string, value: string) => {
            files.set(path, value);
          },
          readFile: async (path: string) => new Response(files.get(path)),
        },
        exec: async () => {
          if (++started === 2) {
            release();
          }
          await bothStarted;
          // The command reads its program only after both requests have
          // written files, reproducing the race when they share a container.
          const marker = files.get('/workspace/void-kitchen-sink-code-lab/user-code.mjs');
          const output = JSON.stringify({ value: marker });
          files.set('/workspace/void-kitchen-sink-code-lab/output.json', output);
          return {
            output: async () => ({
              exitCode: 0,
              stdout: new TextEncoder().encode(output),
              stderr: new ArrayBuffer(0),
            }),
          };
        },
        destroy: vi.fn(),
      };
    }
    mocks.getSandbox.mockImplementation(async (id: string) => {
      let container = containers.get(id);
      if (!container) {
        container = createContainer();
        containers.set(id, container);
      }
      return container;
    });

    const [first, second] = await Promise.all([
      request('first program'),
      request('second program'),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstResult = (await first.json()) as { output: { value: string } };
    const secondResult = (await second.json()) as { output: { value: string } };
    expect(firstResult.output.value).toBe('first program');
    expect(secondResult.output.value).toBe('second program');
    expect(containers.size).toBe(2);
    for (const container of containers.values()) {
      expect(container.destroy).toHaveBeenCalledOnce();
    }
  });

  it('destroys a container when execution fails and preserves the reported error', async () => {
    const destroy = vi.fn();
    mocks.getSandbox.mockResolvedValue({
      files: { mkdir: vi.fn(), writeFile: vi.fn() },
      exec: vi.fn().mockRejectedValue(new Error('command failed')),
      destroy,
    });
    const response = await request('invalid program');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: 'command failed' });
    expect(destroy).toHaveBeenCalledOnce();
  });
});
