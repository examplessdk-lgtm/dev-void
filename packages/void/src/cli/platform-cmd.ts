import type { PlatformDiscoveryDocument } from '@void/platform';
import { isCancel, log, select, text } from '@voidzero-dev/vite-plus-prompts';
import { cfAccessHeaders } from '../shared/cf-access.ts';
import {
  ensureCloudflaredToken,
  ensurePlatformAccessToken,
  isCloudflareAccessChallenge,
} from './cf-access.ts';
import { pc } from './output.ts';
import type { PlatformArgs } from './platform-args.ts';
import { readPlatformDiscoveryResponse } from './platform-discovery.ts';
import {
  getActivePlatformConnection,
  listPlatformConnections,
  normalizePlatformApiUrl,
  savePlatformConnection,
  selectPlatformConnection,
  type PlatformConnection,
} from './platform-registry.ts';

export async function discoverPlatform(
  input: string,
  fetcher: typeof fetch = fetch,
): Promise<PlatformDiscoveryDocument> {
  const apiUrl = normalizePlatformApiUrl(input);
  ensureCloudflaredToken(apiUrl);
  const request = () =>
    fetcher(`${apiUrl}/.well-known/void-platform`, {
      headers: { Accept: 'application/json', ...cfAccessHeaders(process.env, apiUrl) },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
  let response = await request();
  if (isCloudflareAccessChallenge(response)) {
    await response.body?.cancel();
    ensurePlatformAccessToken(apiUrl, true);
    response = await request();
  }
  return readPlatformDiscoveryResponse(apiUrl, response);
}

export async function promptPlatformUrl(): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error('platform: A platform URL is required in non-interactive mode.');
  }
  const value = await text({
    message: 'Void platform API URL:',
    placeholder: 'https://platform.example.com',
    validate: (input) => {
      if (!input) {
        return 'Enter a platform URL.';
      }
      try {
        normalizePlatformApiUrl(input);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  });
  if (isCancel(value) || typeof value === 'symbol') {
    throw new Error('platform: Cancelled.');
  }
  return value;
}

async function resolveConnection(selector: string): Promise<PlatformConnection> {
  if (selector) {
    return selectPlatformConnection(selector);
  }
  const connections = listPlatformConnections();
  if (connections.length === 0) {
    throw new Error('platform: No platforms configured. Run `void connect <url>`.');
  }
  if (connections.length === 1) {
    return selectPlatformConnection(connections[0]!.id);
  }
  if (!process.stdin.isTTY) {
    throw new Error('platform: Multiple platforms are configured; specify an id or URL.');
  }
  const picked = await select({
    message: 'Select a Void platform:',
    options: connections.map((connection) => ({
      label: connection.displayName,
      hint: connection.apiUrl,
      value: connection.id,
    })),
  });
  if (isCancel(picked)) {
    throw new Error('platform: Cancelled.');
  }
  return selectPlatformConnection(String(picked));
}

function showConnection(connection: PlatformConnection, activeId: string | null): void {
  const marker = connection.id === activeId ? pc.green('●') : pc.dim('○');
  console.log(`${marker} ${pc.bold(connection.displayName)}  ${pc.dim(connection.id)}`);
  console.log(`  ${connection.apiUrl}`);
  if (connection.applicationDomain) {
    console.log(
      connection.applicationDomain.endsWith('.workers.dev')
        ? '  apps: workers.dev (testing)'
        : `  apps: *.${connection.applicationDomain}`,
    );
  }
}

export function saveDiscoveredPlatform(discovery: PlatformDiscoveryDocument): PlatformConnection {
  return savePlatformConnection({
    accountId: null,
    apiUrl: discovery.apiUrl,
    applicationDomain: discovery.applicationDomain,
    displayName: discovery.displayName,
    installationId: discovery.installationId,
    kind: discovery.installationId ? 'installed' : 'connected',
    proxyUrl: discovery.proxyUrl,
  });
}

export async function runPlatformCommand(_root: string, args: PlatformArgs): Promise<void> {
  if (args.subcommand === 'config') {
    if ('configGroup' in args) {
      if (args.configGroup === '') {
        if (!process.stdin.isTTY) {
          throw new Error(
            'platform: Choose void platform config auth or void platform config plans.',
          );
        }
        const group = await select({
          message: 'Platform configuration:',
          options: [
            { value: 'auth', label: 'Authentication and protection' },
            { value: 'plans', label: 'Plans and limits' },
          ],
        });
        if (isCancel(group)) {
          return;
        }
        const { parsePlatformArgs } = await import('./platform-args.ts');
        return runPlatformCommand(_root, parsePlatformArgs(['config', group]));
      }
      const { runPlatformPlansConfig } = await import('./platform-plans-config.ts');
      await runPlatformPlansConfig(args);
      return;
    }
    const { runPlatformAuthConfig } = await import('./platform-auth-config.ts');
    await runPlatformAuthConfig(args);
    return;
  }
  if (args.subcommand === 'operator') {
    const { runOperatorCommand } = await import('./operator-cmd.ts');
    await runOperatorCommand(args);
    return;
  }
  if (args.subcommand === 'list') {
    const connections = listPlatformConnections();
    if (connections.length === 0) {
      log.info('No platforms configured. Run `void connect <url>`.');
      return;
    }
    const activeId = getActivePlatformConnection()?.id ?? null;
    for (const connection of connections) {
      showConnection(connection, activeId);
    }
    return;
  }

  if (args.subcommand === 'use') {
    const connection = await resolveConnection(args.selector);
    log.success(`Using ${pc.bold(connection.displayName)} (${connection.apiUrl}).`);
    return;
  }

  if (args.subcommand === 'status') {
    const connection = await resolveConnection(args.selector);
    const discovery = await discoverPlatform(connection.apiUrl);
    log.success(`${discovery.displayName} is reachable.`);
    console.log(`API: ${discovery.apiUrl}`);
    console.log(`Proxy: ${discovery.proxyUrl}`);
    if (discovery.applicationRouting?.workersDev && !discovery.applicationRouting.zoneName) {
      console.log('Application domain: workers.dev (testing)');
      console.log('Add a domain: void platform domain set <domain>');
    } else {
      console.log(`Applications: *.${discovery.applicationDomain}`);
    }
    console.log(`Version: ${discovery.platformVersion}`);
    console.log(
      `Capabilities: ${Object.entries(discovery.capabilities)
        .filter(([, enabled]) => enabled)
        .map(([name]) => name)
        .join(', ')}`,
    );
    return;
  }

  const { runPlatformLifecycleCommand } = await import('./platform-lifecycle.ts');
  await runPlatformLifecycleCommand(args);
}
