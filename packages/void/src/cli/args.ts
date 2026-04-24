import { parseArgs } from 'node:util';

export interface DeployArgs {
  projectSlug?: string;
  dir?: string;
  spa?: boolean;
  skipBuild?: boolean;
}

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
      },
      allowPositionals: true,
      strict: true,
      tokens: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('argument missing') || message.includes('argument is ambiguous')) {
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

  return { projectSlug, dir, spa, skipBuild };
}
