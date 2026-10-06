#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as p from '@voidzero-dev/vite-plus-prompts';
import { resolve } from 'pathslash';
import pc from 'picocolors';
import { detectPM, pmExec, pmInstall, run, writePnpmBuildPolicy } from './pm.ts';

const pm = detectPM();

async function main() {
  console.log();

  let appName = process.argv[2];

  if (!appName) {
    const name = await p.text({
      message: 'Project name:',
      defaultValue: 'my-app',
      placeholder: 'my-app',
      validate(value) {
        if (value && !value.trim()) {
          return 'Project name cannot be blank';
        }
      },
    });
    if (p.isCancel(name) || typeof name !== 'string') {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    appName = name;
  }

  const targetDir = resolve(appName);

  if (existsSync(targetDir)) {
    const entries = readdirSync(targetDir);
    if (entries.length > 0) {
      p.log.error(`create-void: Directory '${pc.bold(appName)}' is not empty.`);
      process.exit(1);
    }
  }

  // The release publishes the scaffolder and CLI at the same version. Preserve
  // that exact version, including prereleases, instead of switching to latest.
  const { version: voidVersion } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };

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
  // pnpm 12 fails the first install when a dependency has an unapproved build
  // script. Write Void's narrow policy before installing the CLI so a fresh
  // project can bootstrap without disabling pnpm's build-script protection.
  writePnpmBuildPolicy(targetDir, pm);

  p.log.step('Installing Void...');
  await run(pmInstall(pm), targetDir);

  p.log.step('Scaffolding starter...');
  await run([...pmExec(pm), 'void', 'init'], targetDir);

  p.log.step('Installing starter dependencies...');
  await run(pmInstall(pm), targetDir);

  p.log.success(`Created ${pc.bold(appName)}`);
  p.outro(`cd ${appName} && ${pm === 'npm' ? 'npm run' : pm} dev`);
}

main().catch((err) => {
  p.log.error(err.message);
  process.exit(1);
});
