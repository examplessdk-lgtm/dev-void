import { readFileSync } from 'node:fs';
import { intro, outro, log, note, cancel, isCancel, password, confirm } from '@clack/prompts';
import { getToken } from './auth';
import { PlatformClient } from './client';
import { cliTitle } from './output';
import { readProjectConfig } from './project';
import { getRequestedProjectSlug, resolveProjectBySlug } from './resolve-project';
import type { SecretArgs } from './secret-args';

export async function runSecretCommand(root: string, args: SecretArgs): Promise<void> {
  console.log();
  intro(cliTitle('secret'));

  const token = getToken(root);
  if (!token) {
    log.error('Not logged in. Run `void auth login` first.');
    process.exit(1);
  }

  const client = new PlatformClient(token, { root });
  const requestedProjectName = getRequestedProjectSlug({ projectSlug: args.projectName });
  let projectId: string;
  if (requestedProjectName) {
    const projects = await client.listProjects();
    const config = resolveProjectBySlug(projects, requestedProjectName);
    if (!config) {
      throw new Error(`secret: No project found with slug '${requestedProjectName}'.`);
    }
    projectId = config.projectId;
  } else {
    const config = readProjectConfig(root);
    if (!config) {
      throw new Error(
        'No linked project found. Run `void project link`, `void deploy`, or pass --project <name>.',
      );
    }
    projectId = config.projectId;
  }

  if (args.action === 'list') {
    const secrets = await client.listSecrets(projectId);
    if (secrets.length === 0) {
      outro('No secrets set.');
      return;
    }
    note(secrets.map((s) => `  ${s.name}`).join('\n'), 'Secrets');
    outro(`${secrets.length} secret(s)`);
    return;
  }

  if (args.action === 'put') {
    const value = args.value ?? (await readSecretValue());
    await client.setSecret(projectId, args.name, value);
    outro(`Secret ${args.name} set.`);
    return;
  }

  if (args.action === 'sync') {
    const secrets = parseDotenvFile(args.file);
    if (secrets.length === 0) {
      log.warn('No secrets found in file.');
      outro('Nothing to sync.');
      return;
    }

    log.info(`Found ${secrets.length} secret(s):`);
    for (const s of secrets) {
      log.message(`  ${s.name}`);
    }

    const proceed = await confirm({
      message: `This will overwrite ${secrets.length} secret(s) in the remote environment. Continue?`,
    });
    if (isCancel(proceed) || !proceed) {
      cancel('Secret sync cancelled.');
      process.exit(0);
    }

    for (const s of secrets) {
      await client.setSecret(projectId, s.name, s.value);
      log.success(`Set ${s.name}`);
    }
    outro(`Synced ${secrets.length} secret(s).`);
    return;
  }

  await client.deleteSecret(projectId, args.name);
  outro(`Secret ${args.name} deleted.`);
}

const SECRET_KEY_RE = /^[A-Z][A-Z0-9_]*$/;

export function parseDotenvFile(filePath: string): Array<{ name: string; value: string }> {
  const content = readFileSync(filePath, 'utf-8');
  const secrets: Array<{ name: string; value: string }> = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
      throw new Error(`secret: Invalid dotenv line '${trimmed}'. Add KEY=value.`);
    }

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!SECRET_KEY_RE.test(key)) {
      throw new Error(
        `secret: Invalid secret name '${key}'. Use uppercase letters, digits, and underscores.`,
      );
    }

    secrets.push({ name: key, value });
  }

  return secrets;
}

async function readSecretValue(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Array<Buffer> = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    const value = Buffer.concat(chunks).toString('utf-8');
    if (value.length === 0) {
      throw new Error('Secret value is required.');
    }
    return value;
  }

  const result = await password({
    message: 'Enter secret value:',
    mask: '*',
  });

  if (isCancel(result)) {
    cancel('Secret command cancelled.');
    process.exit(0);
  }

  const value = result ?? '';
  if (value.length === 0) {
    throw new Error('Secret value is required.');
  }
  return value;
}
