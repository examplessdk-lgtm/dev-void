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

export function pmInstall(pm: PM): string[] {
  return [pm, 'install'];
}

export function pmExec(pm: PM): string[] {
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

export function run(argv: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd, args, { stdio: 'inherit', cwd });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd} exited with code ${code}`));
      }
    });
    child.on('error', reject);
  });
}
