import { join } from 'node:path';
import { parseRedirectsFile } from '../cli/headers';
import { readConfig } from '../config';

export interface StaticPageDataBuildOptions {
  enabled: boolean;
  fastPath: boolean;
}

interface ResolveStaticPageDataBuildOptionsInput {
  publicDir?: string | false;
}

export function resolveStaticPageDataBuildOptions(
  root: string,
  options: ResolveStaticPageDataBuildOptionsInput = {},
): StaticPageDataBuildOptions {
  const config = readConfig(root);
  const enabled = config.output === 'static';
  const configRedirects = config.routing?.redirects;
  const hasConfigRedirects =
    configRedirects !== undefined && Object.keys(configRedirects).length > 0;

  const redirectDirs = [root];
  if (options.publicDir !== false) {
    redirectDirs.push(options.publicDir ?? join(root, 'public'));
  }

  const hasRedirectsFile = redirectDirs.some((dir) => Boolean(parseRedirectsFile(dir)));

  return {
    enabled,
    fastPath: enabled && !hasConfigRedirects && !hasRedirectsFile,
  };
}
