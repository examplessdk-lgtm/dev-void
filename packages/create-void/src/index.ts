#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { detectPM, pmExec, pmInstall, run } from './pm';

const pm = detectPM();

async function getLatestVersion(pkg: string): Promise<string> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`);
    const data = (await res.json()) as { version?: string };
    if (data.version) {
      return `^${data.version}`;
    }
  } catch {
    // Empty.
  }
  return 'latest';
}

async function main() {
  console.log();
  p.intro(pc.bgCyan(pc.black(' create-void ')));

  // 1. Get app name from argv or prompt
  let appName = process.argv[2];

  if (!appName) {
    const name = await p.text({
      message: 'Project name:',
      placeholder: 'my-app',
      validate(value) {
        if (!value?.trim()) {
          return 'Project name is required';
        }
      },
    });
    if (p.isCancel(name)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    appName = name;
  }

  // 2. Validate target dir
  const targetDir = resolve(appName);

  if (existsSync(targetDir)) {
    const entries = readdirSync(targetDir);
    if (entries.length > 0) {
      p.log.error(`create-void: Directory '${pc.bold(appName)}' is not empty.`);
      process.exit(1);
    }
  }

  // 3. Resolve the CLI version first so we can run void init locally
  const voidVersion = await getLatestVersion('void');

  // 4. Scaffold: create dir, write package.json, install void, run init, install starter deps
  mkdirSync(targetDir, { recursive: true });

  const pkg = {
    name: appName,
    private: true,
    type: 'module',
    devDependencies: {
      void: voidVersion,
    },
  };

  writeFileSync(resolve(targetDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

  p.log.step('Installing Void...');
  await run([...pmInstall(pm)], targetDir);

  p.log.step('Scaffolding starter...');
  await run([...pmExec(pm), 'void', 'init'], targetDir);

  p.log.step('Installing starter dependencies...');
  await run([...pmInstall(pm)], targetDir);

  p.log.success(`Created ${pc.bold(appName)}`);
  p.outro(`cd ${appName} && ${pm === 'npm' ? 'npm run' : pm} dev`);
}

main().catch((err) => {
  p.log.error(err.message);
  process.exit(1);
});
