import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  allowPositionals: true,
  options: {
    build: {
      type: 'boolean',
    },
    env: {
      short: 'e',
      type: 'string',
    },
  },
  strict: false,
});

const env = values.env;

if (env !== 'production' && env !== 'staging') {
  console.error(
    'wrangler deploy must be called with an explicit environment: --env production or --env staging.',
  );
  process.exit(1);
}

if (values.build === true) {
  const build = spawnSync('vp', ['build'], {
    env: {
      ...process.env,
      CLOUDFLARE_ENV: process.env.CLOUDFLARE_ENV ?? env,
    },
    stdio: 'inherit',
  });

  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }
}

const wranglerArgs = process.argv.slice(2).filter((arg) => arg !== '--build');

const deploy = spawnSync('wrangler', ['deploy', ...wranglerArgs], {
  stdio: 'inherit',
});

process.exit(deploy.status ?? 1);
