import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'pathslash';

type Tsconfig = Record<string, unknown>;
type TsconfigHook = (config: Tsconfig) => Tsconfig | void;

export type VoidSvelteKitTsconfigOptions = {
  /** Project root. Defaults to process.cwd(). */
  root?: string;
  /** SvelteKit output directory. Defaults to ".svelte-kit". */
  outDir?: string;
};

/**
 * Merge Void's generated tsconfig fragment into SvelteKit's generated
 * tsconfig. Use from `kit.typescript.config` in `svelte.config.js`.
 */
export function mergeVoidSvelteKitTsconfig(
  config: Tsconfig,
  options: VoidSvelteKitTsconfigOptions = {},
): Tsconfig {
  const root = options.root ?? process.cwd();
  const voidDir = join(root, '.void');
  const voidTsconfigPath = join(voidDir, 'tsconfig.json');
  if (!existsSync(voidTsconfigPath)) {
    return config;
  }

  const voidConfig = JSON.parse(readFileSync(voidTsconfigPath, 'utf-8')) as Tsconfig;
  const outputDir = resolve(root, options.outDir ?? '.svelte-kit');

  const voidFiles = Array.isArray(voidConfig.files)
    ? voidConfig.files.filter((entry): entry is string => typeof entry === 'string')
    : [];
  if (voidFiles.length > 0) {
    const files = Array.isArray(config.files)
      ? config.files.filter((entry): entry is string => typeof entry === 'string')
      : [];
    config.files = uniqueStrings([
      ...files,
      ...voidFiles.map((entry) => relativeFrom(outputDir, resolveTsconfigEntry(voidDir, entry))),
    ]);
  }

  const voidPaths = readPathMap(readObject(readObject(voidConfig.compilerOptions)?.paths));
  if (Object.keys(voidPaths).length > 0) {
    const compilerOptions = ensureObject(config, 'compilerOptions');
    const paths = ensureObject(compilerOptions, 'paths') as Record<string, Array<string>>;
    for (const [key, values] of Object.entries(voidPaths)) {
      paths[key] = values.map((entry) =>
        relativeFrom(outputDir, resolveTsconfigEntry(voidDir, entry)),
      );
    }
  }

  return config;
}

/**
 * Compose a user SvelteKit tsconfig hook with Void's generated type aliases.
 */
export function withVoidTSConfig(
  hook?: TsconfigHook,
  options?: VoidSvelteKitTsconfigOptions,
): TsconfigHook {
  return (config) => mergeVoidSvelteKitTsconfig(hook?.(config) ?? config, options);
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function ensureObject(target: Tsconfig, key: string): Record<string, unknown> {
  const current = readObject(target[key]);
  if (current) {
    return current;
  }
  const next: Record<string, unknown> = {};
  target[key] = next;
  return next;
}

function readPathMap(value: Record<string, unknown> | null): Record<string, Array<string>> {
  const result: Record<string, Array<string>> = {};
  if (!value) {
    return result;
  }
  for (const [key, entries] of Object.entries(value)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    const strings = entries.filter((entry): entry is string => typeof entry === 'string');
    if (strings.length > 0) {
      result[key] = strings;
    }
  }
  return result;
}

function resolveTsconfigEntry(baseDir: string, entry: string): string {
  return isAbsolute(entry) ? entry : resolve(baseDir, entry);
}

function relativeFrom(fromDir: string, target: string): string {
  const value = relative(fromDir, target);
  return value.startsWith('.') ? value : `./${value}`;
}

function uniqueStrings(values: Array<string>): Array<string> {
  return Array.from(new Set(values));
}
