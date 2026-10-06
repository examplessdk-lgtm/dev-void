import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
  it('works offline without credentials and leaves project files untouched', () => {
    const root = project();
    const before = readdirSync(root);
    const result = runVoid(root, ['info']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Inferred name: chat-room');
    expect(result.stdout).toContain(
      "To preserve this resource when moving its code, add this to 'defineRoom':",
    );
    expect(readdirSync(root)).toEqual(before);
  });

  it('prints clean JSON and exposes the command in help', () => {
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
    const help = runVoid(root, ['info', '--help']);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('void info [--json]');
  });

  it('lets a user discover, pin and move a room while preserving its generated identity', () => {
    const root = project();
    const inferred = JSON.parse(runVoid(root, ['info', '--json']).stdout).resources[0];
    writeFileSync(
      join(root, 'routes/chat/[room].ws.ts'),
      `export default defineRoom({ name: ${JSON.stringify(inferred.name)}, messages: {} });`,
    );
    const pinned = JSON.parse(runVoid(root, ['info', '--json']).stdout).resources[0];
    expect(pinned).toMatchObject({
      name: inferred.name,
      className: inferred.className,
      bindingName: inferred.bindingName,
      nameSource: 'explicit',
    });
    mkdirSync(join(root, 'routes/rooms'), { recursive: true });
    renameSync(join(root, 'routes/chat/[room].ws.ts'), join(root, 'routes/rooms/[room].ws.ts'));
    const movedResult = runVoid(root, ['info', '--json']);
    expect(movedResult.status, movedResult.stderr).toBe(0);
    expect(JSON.parse(movedResult.stdout).resources[0]).toMatchObject({
      file: 'routes/rooms/[room].ws.ts',
      route: '/rooms/:room',
      name: inferred.name,
      className: inferred.className,
      bindingName: inferred.bindingName,
      nameSource: 'explicit',
    });
  });

  it('rejects invalid arguments with a structured JSON error', () => {
    const root = project();
    const result = runVoid(root, ['info', '--json', '--remote']);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({ error: 'invalid_command' });
  });
});
