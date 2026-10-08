import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  killChild,
  shouldCopyPlaygroundPath,
  startServer,
} from '../../../../test/integration-helpers.ts';

// Answers HTTP on 127.0.0.1:<port> after a short delay, like a dev server that is still starting,
// and prints its URL once it listens.
const SERVER = `setTimeout(() => {
  const port = Number(process.argv[1]);
  require('node:http')
    .createServer((_, res) => res.end('ok'))
    .listen(port, '127.0.0.1', () => console.log('Listening on http://127.0.0.1:' + port));
}, 200);`;

describe('startServer', () => {
  it('starts the server again on a new port when another process takes its port first', async () => {
    const ports: Array<number> = [];
    let other: Server | undefined;
    try {
      const server = await startServer((port) => {
        ports.push(port);
        if (!other) {
          other = createServer((socket) => socket.destroy()).listen(port, '127.0.0.1');
        }
        return spawn(process.execPath, ['-e', SERVER, String(port)], { stdio: 'pipe' });
      }, 10_000);
      try {
        expect(ports).toHaveLength(2);
        expect(server.port).toBe(ports[1]);
        expect(server.port).not.toBe(ports[0]);
        expect(await (await fetch(server.base)).text()).toBe('ok');
      } finally {
        await killChild(server.child);
      }
    } finally {
      other?.close();
    }
  });

  it('does not accept another server that answers on the port before this one listens', async () => {
    const ports: Array<number> = [];
    let other: Server | undefined;
    try {
      const server = await startServer((port) => {
        ports.push(port);
        if (!other) {
          other = createHttpServer((_, res) => res.end('other')).listen(port, '127.0.0.1');
        }
        return spawn(process.execPath, ['-e', SERVER, String(port)], { stdio: 'pipe' });
      }, 10_000);
      try {
        expect(ports).toHaveLength(2);
        expect(server.port).toBe(ports[1]);
        expect(await (await fetch(server.base)).text()).toBe('ok');
      } finally {
        await killChild(server.child);
      }
    } finally {
      other?.close();
    }
  });

  it('starts the server again when it moves to another port instead of exiting', async () => {
    const ports: Array<number> = [];
    const server = await startServer((port) => {
      ports.push(port);
      // What Vite without --strictPort prints before it listens on the next port.
      const script =
        ports.length === 1
          ? `console.log('Port ${port} is in use, trying another one...'); setInterval(() => {}, 1000);`
          : SERVER;
      return spawn(process.execPath, ['-e', script, String(port)], { stdio: 'pipe' });
    }, 10_000);
    try {
      expect(ports).toHaveLength(2);
      expect(await (await fetch(server.base)).text()).toBe('ok');
    } finally {
      await killChild(server.child);
    }
  });

  it('does not retry a server that fails for another reason', async () => {
    let starts = 0;
    await expect(
      startServer(() => {
        starts++;
        return spawn(process.execPath, ['-e', 'console.error("config error"); process.exit(1)'], {
          stdio: 'pipe',
        });
      }, 10_000),
    ).rejects.toThrow(/Server stopped while waiting[\s\S]*config error/);
    expect(starts).toBe(1);
  });
});

describe('shouldCopyPlaygroundPath', () => {
  it('excludes generated top-level entries from native Windows paths', () => {
    const sourceRoot = String.raw`D:\a\void\void\playground\spa`;

    expect(shouldCopyPlaygroundPath(sourceRoot, String.raw`${sourceRoot}\node_modules`)).toBe(
      false,
    );
    expect(shouldCopyPlaygroundPath(sourceRoot, String.raw`${sourceRoot}\.void`)).toBe(false);
    expect(
      shouldCopyPlaygroundPath(sourceRoot, String.raw`${sourceRoot}\.next\types\routes.d.ts`),
    ).toBe(false);
    expect(shouldCopyPlaygroundPath(sourceRoot, String.raw`${sourceRoot}\src\index.ts`)).toBe(true);
  });

  it('only excludes generated entries at the playground root', () => {
    const sourceRoot = '/workspace/playground/spa';

    expect(shouldCopyPlaygroundPath(sourceRoot, `${sourceRoot}/dist`)).toBe(false);
    expect(shouldCopyPlaygroundPath(sourceRoot, `${sourceRoot}/.next/types/routes.d.ts`)).toBe(
      false,
    );
    expect(shouldCopyPlaygroundPath(sourceRoot, `${sourceRoot}/src/dist/example.ts`)).toBe(true);
    expect(shouldCopyPlaygroundPath(sourceRoot, `${sourceRoot}/src/.next/example.ts`)).toBe(true);
  });
});

it('keeps scratch apps and copied manifests outside the actual workspace package globs', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'void-isolated-playground-'));
  const source = join(workspace, 'playground', 'app');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'original-app' }));
  writeFileSync(join(source, 'entry.ts'), 'export const marker = "original";');
  const scratch = join(workspace, 'playground-local', 'ad-hoc');
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'scratch-app' }));
  const patterns = readFileSync(new URL('../../../../pnpm-workspace.yaml', import.meta.url), 'utf8')
    .split('\n\n')[0]!
    .split('\n')
    .flatMap((line) => line.match(/^ {2}- (\S+)$/)?.[1] ?? []);
  expect(patterns).toContain('playground/*');
  const first = createIsolatedPlayground(workspace, 'playground/app');
  const second = createIsolatedPlayground(workspace, 'playground/app');
  try {
    const manifests = () =>
      patterns
        .flatMap((pattern) => globSync(`${pattern}/package.json`, { cwd: workspace }))
        .map((path) => path.replaceAll('\\', '/'));
    expect(manifests()).toEqual(['playground/app/package.json']);
    expect(readFileSync(join(first.root, 'entry.ts'), 'utf8')).toContain('original');
    expect(JSON.parse(readFileSync(join(first.root, 'package.json'), 'utf8')).name).not.toBe(
      JSON.parse(readFileSync(join(second.root, 'package.json'), 'utf8')).name,
    );
    first.cleanup();
    expect(manifests()).toEqual(['playground/app/package.json']);
    expect(existsSync(join(second.root, 'package.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).name).toBe(
      'original-app',
    );
  } finally {
    first.cleanup();
    second.cleanup();
    rmSync(workspace, { recursive: true, force: true });
  }
});

it('clears the shutdown deadline after a real child exits', () => {
  const helper = new URL('../../../../test/integration-helpers.ts', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { spawn } from 'node:child_process';
    import { killChild } from ${JSON.stringify(helper)};
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore' });
    try {
      await killChild(child);
      console.log(JSON.stringify(process.getActiveResourcesInfo().filter(type => type === 'Timeout')));
    } finally {
      child.kill('SIGKILL');
    }
    process.exit(0);
  `,
    ],
    { encoding: 'utf8', timeout: 15_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('[]');
}, 20_000);

it('resolves installed dependency links absolutely at the isolated fixture depth', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'void-fixture-dependencies-'));
  const source = join(workspace, 'playground', 'app');
  const modules = join(source, 'node_modules');
  mkdirSync(join(modules, '@fixture'), { recursive: true });
  mkdirSync(join(modules, '$app'), { recursive: true });
  writeFileSync(join(modules, '$app/tsconfig.json'), '{"files":["original.d.ts"]}');
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'dependency-app' }));
  writeFileSync(
    join(source, 'entry.mjs'),
    'import plain from "plain"; import scoped from "@fixture/scoped"; console.log(JSON.stringify([plain, scoped]));',
  );
  for (const name of ['plain', '@fixture/scoped']) {
    const installed = join(workspace, 'packages', name);
    mkdirSync(installed, { recursive: true });
    writeFileSync(
      join(installed, 'package.json'),
      JSON.stringify({ name, type: 'module', exports: './index.mjs' }),
    );
    writeFileSync(join(installed, 'index.mjs'), `export default ${JSON.stringify(name)};`);
    const link = join(modules, name);
    symlinkSync(
      relative(join(link, '..'), installed),
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
  const fixture = createIsolatedPlayground(workspace, 'playground/app');
  try {
    expect(existsSync(join(fixture.root, 'node_modules/$app'))).toBe(false);
    for (const name of ['plain', '@fixture/scoped']) {
      const link = join(fixture.root, 'node_modules', name);
      expect(isAbsolute(readlinkSync(link))).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(join(workspace, 'packages', name)));
    }
    const result = spawnSync(process.execPath, ['entry.mjs'], {
      cwd: fixture.root,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['plain', '@fixture/scoped']);
  } finally {
    fixture.cleanup();
    rmSync(workspace, { recursive: true, force: true });
  }
});
