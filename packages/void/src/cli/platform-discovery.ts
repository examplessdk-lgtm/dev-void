import { parsePlatformDiscoveryDocument, type PlatformDiscoveryDocument } from '@void/platform';
import { normalizePlatformApiUrl } from './platform-registry.ts';

/** Validates a `GET /.well-known/void-platform` response from `apiUrl`. */
export async function readPlatformDiscoveryResponse(
  apiUrl: string,
  response: Response,
): Promise<PlatformDiscoveryDocument> {
  if (!response.ok) {
    await response.body?.cancel();
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
