import { parseArgs } from 'node:util';

export type DeployArgs = {
  projectSlug?: string;
  dir?: string;
  spa?: boolean;
  skipBuild?: boolean;
  debug?: boolean;
  platform?: 'cloudflare' | 'void';
  backend?: 'cloudflare';
  provision?: boolean;
  requireEmail?: boolean;
};

export function parseDeployArgs(args: Array<string>): DeployArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      options: {
        project: { type: 'string' },
        dir: { type: 'string' },
        spa: { type: 'boolean' },
        'skip-build': { type: 'boolean' },
        debug: { type: 'boolean' },
        platform: { type: 'string' },
        backend: { type: 'string' },
        provision: { type: 'boolean' },
        'require-email': { type: 'boolean' },
      },
      allowPositionals: true,
      strict: true,
      tokens: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('argument missing') || message.includes('argument is ambiguous')) {
      const optionMatch = message.match(/Option '(--[a-z-]+)/);
      if (optionMatch?.[1] === '--platform') {
        throw new Error("deploy: --platform requires a value ('cloudflare' or 'void').");
      }
      if (optionMatch?.[1] === '--backend') {
        throw new Error("deploy: --backend requires a value ('cloudflare').");
      }
      throw new Error('deploy: --project requires a slug.');
    }

    const unknownOptionMatch = message.match(/Unknown option '([^']+)'/);
    if (unknownOptionMatch) {
      throw new Error(`deploy: Unknown option '${unknownOptionMatch[1]}'.`);
    }

    throw new Error(`deploy: ${message}.`);
  }

  const tokens = parsed.tokens ?? [];
  const projectTokens = tokens.filter(
    (token) => token.kind === 'option' && token.name === 'project',
  );
  if (projectTokens.length > 1) {
    throw new Error('deploy: --project can only be specified once.');
  }

  const backendTokens = tokens.filter(
    (token) => token.kind === 'option' && token.name === 'backend',
  );
  if (backendTokens.length > 1) {
    throw new Error('deploy: --backend can only be specified once.');
  }

  const platformTokens = tokens.filter(
    (token) => token.kind === 'option' && token.name === 'platform',
  );
  if (platformTokens.length > 1) {
    throw new Error('deploy: --platform can only be specified once.');
  }
  if (platformTokens.length > 0 && backendTokens.length > 0) {
    throw new Error('deploy: --platform and --backend cannot be used together.');
  }

  if (parsed.positionals.length > 0) {
    throw new Error(`deploy: Unexpected argument '${parsed.positionals[0]}'.`);
  }

  const projectValue = parsed.values.project;
  const projectSlug = typeof projectValue === 'string' ? projectValue : undefined;
  if (typeof projectSlug === 'string' && projectSlug.startsWith('-')) {
    throw new Error('deploy: --project requires a slug.');
  }

  const dir = typeof parsed.values.dir === 'string' ? parsed.values.dir : undefined;
  const spa = parsed.values.spa === true ? true : undefined;
  const skipBuild = parsed.values['skip-build'] === true ? true : undefined;
  const debug = parsed.values.debug === true ? true : undefined;

  const platformValue =
    typeof parsed.values.platform === 'string' ? parsed.values.platform : undefined;
  if (platformValue !== undefined && platformValue !== 'cloudflare' && platformValue !== 'void') {
    throw new Error("deploy: --platform must be 'cloudflare' or 'void'.");
  }
  const platform = platformValue;

  const backendValue =
    typeof parsed.values.backend === 'string' ? parsed.values.backend : undefined;
  if (backendValue !== undefined && backendValue !== 'cloudflare') {
    throw new Error("deploy: --backend must be 'cloudflare'.");
  }
  const backend = backendValue;

  const provision = parsed.values.provision === true ? true : undefined;
  if (provision && backend !== 'cloudflare' && platform !== 'cloudflare') {
    throw new Error('deploy: --provision requires --platform cloudflare.');
  }

  // Mode B email (design doc 0078): fail the deploy — before any upload — instead of
  // continuing without email when the domain is not set up and nobody can press Enter
  // (CI / non-TTY). Only the Cloudflare backend runs the email step.
  const requireEmail = parsed.values['require-email'] === true ? true : undefined;
  if (requireEmail && backend !== 'cloudflare' && platform !== 'cloudflare') {
    throw new Error('deploy: --require-email requires --platform cloudflare.');
  }

  // The Cloudflare backend deploys the built worker to the user's OWN Cloudflare account
  // via their local wrangler auth — it never resolves a Void project, and it never takes
  // the managed static-site path. `--project`, `--dir` and `--spa` all read as instructions
  // that path cannot carry out, and it used to accept and then ignore them: `--project foo`
  // in particular looked like it selected a deploy destination while the worker went to the
  // local wrangler account instead. Reject them here rather than deploy somewhere else.
  if (backend === 'cloudflare' || platform === 'cloudflare') {
    if (projectSlug !== undefined) {
      throw new Error(
        'deploy: --project is not supported with --platform cloudflare — this platform deploys ' +
          'to your own Cloudflare account and no Void project is involved.',
      );
    }
    if (dir !== undefined) {
      throw new Error(
        'deploy: --dir is not supported with --platform cloudflare — this platform uploads the ' +
          'worker your build emits, not a static directory.',
      );
    }
    if (spa) {
      throw new Error(
        'deploy: --spa is not supported with --platform cloudflare — this platform uploads the ' +
          'worker your build emits, not a static SPA.',
      );
    }
  }

  return { projectSlug, dir, spa, skipBuild, debug, platform, backend, provision, requireEmail };
}
