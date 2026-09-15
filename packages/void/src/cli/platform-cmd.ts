import { isCancel, log, select, text } from '@clack/prompts';
import { parsePlatformDiscoveryDocument, type PlatformDiscoveryDocument } from '@void/platform';
import { cfAccessHeaders } from '../shared/cf-access.ts';
import { ensureCloudflaredToken } from './cf-access.ts';
import { pc } from './output.ts';
import type { PlatformArgs } from './platform-args.ts';
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
  const response = await fetcher(`${apiUrl}/.well-known/void-platform`, {
    headers: { Accept: 'application/json', ...cfAccessHeaders(process.env, apiUrl) },
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`platform: Discovery failed at ${apiUrl} (HTTP ${response.status}).`);
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(`platform: ${apiUrl} returned invalid discovery metadata.`);
  }
  let discovery: PlatformDiscoveryDocument;
  try {
    discovery = parsePlatformDiscoveryDocument(value);
  } catch (error) {
    throw new Error(
      `platform: ${apiUrl} returned invalid discovery metadata: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const finalOrigin = normalizePlatformApiUrl(response.url ? new URL(response.url).origin : apiUrl);
  if (discovery.apiUrl !== finalOrigin) {
    throw new Error(
      `platform: Discovery origin mismatch. The response came from ${finalOrigin}, but identifies ${discovery.apiUrl}.`,
    );
  }
  return discovery;
}

async function promptUrl(): Promise<string> {
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
    throw new Error('platform: No platforms configured. Run `void platform connect <url>`.');
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
    console.log(`  apps: *.${connection.applicationDomain}`);
  }
}

export async function runPlatformCommand(_root: string, args: PlatformArgs): Promise<void> {
  if (args.subcommand === 'connect') {
    const discovery = await discoverPlatform(args.url || (await promptUrl()));
    const connection = savePlatformConnection({
      accountId: null,
      apiUrl: discovery.apiUrl,
      applicationDomain: discovery.applicationDomain,
      displayName: discovery.displayName,
      installationId: discovery.installationId,
      kind: discovery.installationId ? 'installed' : 'connected',
      proxyUrl: discovery.proxyUrl,
    });
    log.success(`Connected to ${pc.bold(connection.displayName)} at ${connection.apiUrl}.`);
    log.info('Run `void auth login` to authenticate with this platform.');
    return;
  }

  if (args.subcommand === 'list') {
    const connections = listPlatformConnections();
    if (connections.length === 0) {
      log.info('No platforms configured. Run `void platform connect <url>`.');
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
    console.log(`Applications: *.${discovery.applicationDomain}`);
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
