import { log, outro } from '@voidzero-dev/vite-plus-prompts';
import { getToken } from './auth.ts';
import { PlatformClient } from './client.ts';
import { dim, tablePrefix } from './output.ts';
import type { ProjectArgs } from './project-args.ts';
import { readProjectConfig } from './project.ts';
import { requireProjectBySlug } from './resolve-project.ts';

type TokenArgs = Extract<ProjectArgs, { subcommand: 'token' }>;

async function resolveTarget(root: string, args: TokenArgs) {
  const humanToken = getToken(root);
  if (!humanToken) {
    throw new Error('project: Sign in with a human account before managing CI credentials.');
  }
  const client = new PlatformClient(humanToken, { root });
  if (args.projectSlug) {
    const resolved = await requireProjectBySlug(client, args.projectSlug);
    return { client, projectId: resolved.projectId, slug: args.projectSlug };
  }
  const linked = readProjectConfig(root);
  if (!linked) {
    throw new Error('project: No linked project. Pass --project <name>.');
  }
  return { client, projectId: linked.projectId, slug: linked.slug };
}

function printIssued(
  args: TokenArgs,
  result: { id: string; token: string; expiresAt: string },
  apiUrl: string,
) {
  if (args.json) {
    console.log(JSON.stringify({ ...result, apiUrl }));
    return;
  }
  log.success(`Credential ${result.id} is valid until ${result.expiresAt}.`);
  log.warn('Copy this token now. Void will not display it again.');
  console.log(`\nVOID_TOKEN=${result.token}\nVOID_API_URL=${apiUrl}\n`);
}

export async function runProjectTokenCommand(root: string, args: TokenArgs): Promise<void> {
  if (!args.json) {
    console.log();
  }
  const { client, projectId, slug } = await resolveTarget(root, args);
  if (args.action === 'create') {
    const result = await client.createProjectToken(projectId, {
      ...(args.name ? { name: args.name } : {}),
      ...(args.expiresInDays ? { expiresInDays: args.expiresInDays } : {}),
    });
    printIssued(args, result, client.apiUrl);
  } else if (args.action === 'renew') {
    printIssued(
      args,
      await client.renewProjectToken(projectId, args.credentialId, args.expiresInDays),
      client.apiUrl,
    );
  } else if (args.action === 'revoke') {
    await client.revokeProjectToken(projectId, args.credentialId);
    if (args.json) {
      console.log(JSON.stringify({ ok: true, id: args.credentialId }));
    } else {
      log.success(`Revoked ${args.credentialId}.`);
    }
  } else {
    const rows = await client.listProjectTokens(projectId);
    if (args.json) {
      console.log(JSON.stringify(rows));
      return;
    }
    const prefix = tablePrefix();
    console.log(prefix);
    console.log(
      `${prefix}${dim('id                                    status   expires     name')}`,
    );
    for (const row of rows) {
      const status = row.revokedAt
        ? 'revoked'
        : Date.parse(row.expiresAt) <= Date.now()
          ? 'expired'
          : 'active';
      console.log(
        `${prefix}${row.id.padEnd(38)}${status.padEnd(9)}${row.expiresAt.slice(0, 10)}  ${row.name}`,
      );
    }
    if (rows.length === 0) {
      log.info('No CI deploy credentials.');
    }
  }
  if (!args.json) {
    outro(`${slug} — project-scoped deploy access only`);
  }
}
