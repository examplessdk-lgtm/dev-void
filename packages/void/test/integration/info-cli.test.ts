import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';

const CLI_ENTRY = join(import.meta.dirname, '../../dist/cli/cli.mjs');
const roots: Array<string> = [];
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-info-cli-'));
  roots.push(root);
  mkdirSync(join(root, 'routes/chat'), { recursive: true });
  writeFileSync(
    join(root, 'routes/chat/[room].ws.ts'),
    'export default defineRoom({ messages: {} });',
  );
  return root;
}
function runVoid(root: string, args: Array<string>) {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      USERPROFILE: root,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
    },
  });
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('void info (subprocess)', () => {
  it('prints clean JSON without credentials', () => {
    const root = project();
    const result = runVoid(root, ['info', '--json']);
    expect(result.status, result.stderr).toBe(0);
    const info = JSON.parse(result.stdout);
    expect(info.resources[0]).toMatchObject({
      name: 'chat-room',
      className: 'ChatRoomWs',
      bindingName: 'ChatRoomWs',
      nameSource: 'inferred',
    });
    expect(info.recordedResources).toEqual([]);
  });

  it('rejects invalid arguments with a structured JSON error', () => {
    const root = project();
    const result = runVoid(root, ['info', '--json', '--remote']);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({ error: 'invalid_command' });
  });
});
