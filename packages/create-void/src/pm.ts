import { spawn } from 'node:child_process';

export type PM = 'npm' | 'pnpm' | 'yarn' | 'bun';

export function detectPM(): PM {
  const agent = process.env.npm_config_user_agent;
  if (agent) {
    if (agent.startsWith('pnpm/')) {
      return 'pnpm';
    }
    if (agent.startsWith('yarn/')) {
      return 'yarn';
    }
    if (agent.startsWith('bun/')) {
      return 'bun';
    }
  }
  return 'npm';
}

export function pmInstall(pm: PM): ReadonlyArray<string> {
  return [pm, 'install'];
}

export function pmExec(pm: PM): ReadonlyArray<string> {
  switch (pm) {
    case 'npm':
      return ['npx'];
    case 'pnpm':
      return ['pnpm', 'exec'];
    case 'yarn':
      return ['yarn', 'exec'];
    case 'bun':
      return ['bunx'];
  }
}

export function run(argv: ReadonlyArray<string>, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv;
    // On Windows the package-manager entry points (npm, npx, pnpm, yarn, bunx)
    // are .cmd/.ps1 shims that spawn() cannot resolve without a shell, so it
    // throws ENOENT. Enable a shell only on win32; every arg here is a fixed
    // literal (no user input reaches argv), so there is no injection surface.
    const child = spawn(cmd, args, { stdio: 'inherit', cwd, shell: process.platform === 'win32' });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`create-void: '${cmd}' exited with code ${code}.`));
      }
    });
    child.on('error', reject);
  });
}
