import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  getWorkerBundleDir,
  normalizeDirectoryName,
  readBuildOutput,
  writeAssets,
  writeContainerConfig,
  writeRootConfig,
  writeWorkerConfig,
} from '@cloudflare/build-output-utils';
import { type ModuleType, OutputContainerSchema } from '@cloudflare/config';
import ignore from 'ignore';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'pathslash';
import { build } from 'vite';
import { migrateBuiltWranglerConfig } from './cf-config-migrate.ts';

type JsonObject = Record<string, unknown>;

export interface CfBuildOutput {
  directory: string;
  assetsDirectory?: string;
  activeSecrets?: {
    versionId: string;
    bindings: ReadonlyArray<{ name: string; type: 'secret_text' | 'secret_key' }>;
  };
  dispose(): void;
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

// Match the additional modules emitted by the Cloudflare Vite plugin. A complete
// manifest keeps cf from treating text, binary, and Wasm imports as JavaScript.
const moduleTypes: Record<string, ModuleType> = {
  '.js': 'esm',
  '.mjs': 'esm',
  '.cjs': 'cjs',
  '.wasm': 'wasm',
  '.bin': 'data',
  '.txt': 'text',
  '.html': 'text',
  '.sql': 'text',
  '.json': 'json',
  '.map': 'sourcemap',
};

function copyBundle(
  source: string,
  destination: string,
): Record<string, { type: ModuleType }> | null {
  const modules: Record<string, { type: ModuleType }> = {};
  for (const entry of readdirSync(source, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    }
    const absolute = join(entry.parentPath, entry.name);
    if (entry.isSymbolicLink()) {
      const target = realpathSync(absolute);
      const targetRelative = relative(realpathSync(source), target).replace(/\\/g, '/');
      if (
        !targetRelative ||
        targetRelative === '..' ||
        targetRelative.startsWith('../') ||
        isAbsolute(targetRelative)
      ) {
        throw new Error('The built Worker contains a symlink outside its output directory.');
      }
    }
    const name = relative(source, absolute);
    if (
      name === 'wrangler.json' ||
      name === '.dev.vars' ||
      name === join('.vite', 'manifest.json') ||
      // Vite extracts side-effect CSS imports into the Worker output, but they
      // are static build assets rather than Worker modules. Wrangler's module
      // rules do not upload CSS, and a complete cf manifest must omit it too.
      name.endsWith('.css') ||
      name.endsWith('.css.map')
    ) {
      continue;
    }
    const type = moduleTypes[extname(entry.name).toLowerCase()];
    if (!type) {
      return null;
    }
    const destinationPath = join(destination, name);
    mkdirSync(dirname(destinationPath), { recursive: true });
    if (entry.isSymbolicLink()) {
      copyFileSync(realpathSync(absolute), destinationPath);
    } else {
      cpSync(absolute, destinationPath);
    }
    modules[name] = { type };
  }
  return modules;
}

/** Create a private cf Build Output tree from Void's verified Vite artifact. */
export async function prepareCfBuildOutput(
  workerDirectory: string,
  accountId: string,
): Promise<CfBuildOutput | null> {
  const source = resolve(workerDirectory);
  const raw = object(JSON.parse(readFileSync(join(source, 'wrangler.json'), 'utf8')));
  if (!raw) {
    return null;
  }
  if (typeof raw.account_id === 'string' && raw.account_id !== accountId) {
    return null;
  }
  const config = migrateBuiltWranglerConfig(raw);
  if (!config.worker) {
    throw new Error('cf did not produce a Worker configuration.');
  }
  if (typeof raw.main !== 'string' || !raw.main) {
    throw new Error('The built Worker configuration is missing its main entry. Rebuild the app.');
  }
  const entry = raw.main.replaceAll('\\', '/');
  const main = relative(source, resolve(source, entry));
  if (
    isAbsolute(entry) ||
    /^[a-z]:/i.test(entry) ||
    !main ||
    main === '..' ||
    main.startsWith('../')
  ) {
    throw new Error('The built Worker main entry must be inside its output directory.');
  }
  if (!existsSync(join(source, main))) {
    throw new Error(
      `The built Worker main entry ${JSON.stringify(main)} is missing. Rebuild the app.`,
    );
  }

  const assets = object(raw.assets);
  const assetsDirectory = assets?.directory;
  if (assetsDirectory !== undefined && typeof assetsDirectory !== 'string') {
    return null;
  }
  const directory = mkdtempSync(join(tmpdir(), 'void-cf-deploy-'));
  try {
    const bundle = getWorkerBundleDir(directory);
    mkdirSync(bundle, { recursive: true });
    const modules = copyBundle(source, bundle);
    if (!modules) {
      rmSync(directory, { recursive: true, force: true });
      return null;
    }
    await writeRootConfig(directory, { accountId }, { isPreview: false, mode: 'production' });
    await writeWorkerConfig({
      root: directory,
      config: config.worker,
      manifest: { type: 'complete', mainModule: main, modules },
    });
    for (const container of config.containers ?? []) {
      await writeContainerConfig({
        root: directory,
        config: OutputContainerSchema.parse(container),
        directoryName: normalizeDirectoryName(container.name),
      });
    }
    if (typeof assetsDirectory === 'string') {
      const assetPath = resolve(source, assetsDirectory);
      if (!existsSync(assetPath)) {
        rmSync(directory, { recursive: true, force: true });
        return null;
      }
      await writeAssets({ root: directory, sourceDirectory: assetPath });
    }
    await readBuildOutput(directory);
    return {
      directory,
      ...(typeof assetsDirectory === 'string'
        ? { assetsDirectory: resolve(source, assetsDirectory) }
        : {}),
      dispose: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Bundle Void's generated thin static Worker before handing it to cf as prebuilt output. */
export async function prepareCfStaticBuildOutput(options: {
  projectRoot: string;
  configPath: string;
  assetsDirectory: string;
  accountId: string;
}): Promise<CfBuildOutput | null> {
  const raw = object(JSON.parse(readFileSync(options.configPath, 'utf8')));
  if (!raw || typeof raw.main !== 'string' || basename(raw.main) !== raw.main) {
    return null;
  }
  const entry = join(dirname(options.configPath), raw.main);
  if (!existsSync(entry)) {
    return null;
  }
  const scratch = mkdtempSync(join(tmpdir(), 'void-cf-static-'));
  try {
    await build({
      configFile: false,
      root: options.projectRoot,
      publicDir: false,
      logLevel: 'error',
      build: {
        outDir: scratch,
        emptyOutDir: true,
        lib: { entry, formats: ['es'], fileName: 'index' },
        target: 'es2022',
      },
    });
    writeFileSync(
      join(scratch, 'wrangler.json'),
      JSON.stringify({
        ...raw,
        main: 'index.js',
        assets: { ...object(raw.assets), directory: resolve(options.assetsDirectory) },
      }),
      { mode: 0o600 },
    );
    return await prepareCfBuildOutput(scratch, options.accountId);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Bundle an adapter-produced Worker and copy only its public framework assets. */
export async function prepareCfFrameworkBuildOutput(options: {
  projectRoot: string;
  configPath: string;
  accountId: string;
}): Promise<CfBuildOutput | null> {
  const raw = object(JSON.parse(readFileSync(options.configPath, 'utf8')));
  const assets = object(raw?.assets);
  if (!raw || typeof raw.main !== 'string' || typeof assets?.directory !== 'string') {
    return null;
  }
  const configDirectory = dirname(options.configPath);
  const entry = resolve(configDirectory, raw.main);
  const sourceAssets = resolve(configDirectory, assets.directory);
  if (!existsSync(entry) || !existsSync(sourceAssets)) {
    return null;
  }

  const scratch = mkdtempSync(join(tmpdir(), 'void-cf-framework-'));
  const publicAssets = mkdtempSync(join(tmpdir(), 'void-cf-framework-assets-'));
  try {
    const ignored = ignore();
    const ignorePath = join(sourceAssets, '.assetsignore');
    if (existsSync(ignorePath)) {
      ignored.add(readFileSync(ignorePath, 'utf8'));
    }
    const realAssets = realpathSync(sourceAssets);
    for (const file of readdirSync(sourceAssets, { recursive: true, withFileTypes: true })) {
      if (file.isDirectory()) {
        continue;
      }
      const absolute = join(file.parentPath, file.name);
      const name = relative(sourceAssets, absolute).replaceAll('\\', '/');
      if (name === '.assetsignore' || ignored.ignores(name)) {
        continue;
      }
      const destination = join(publicAssets, name);
      mkdirSync(dirname(destination), { recursive: true });
      if (file.isSymbolicLink()) {
        const target = realpathSync(absolute);
        const targetRelative = relative(realAssets, target);
        if (
          targetRelative === '..' ||
          targetRelative.startsWith('../') ||
          isAbsolute(targetRelative)
        ) {
          throw new Error('The framework assets contain a symlink outside the asset directory.');
        }
        copyFileSync(target, destination);
      } else if (file.isFile()) {
        copyFileSync(absolute, destination);
      }
    }
    await build({
      configFile: false,
      root: options.projectRoot,
      publicDir: false,
      logLevel: 'error',
      build: {
        outDir: scratch,
        emptyOutDir: true,
        lib: { entry, formats: ['es'], fileName: 'index' },
        rollupOptions: { external: [/^cloudflare:/, /^node:/] },
        target: 'es2022',
      },
    });
    writeFileSync(
      join(scratch, 'wrangler.json'),
      JSON.stringify({
        ...raw,
        main: 'index.js',
        assets: { ...assets, directory: publicAssets },
      }),
      { mode: 0o600 },
    );
    const prepared = await prepareCfBuildOutput(scratch, options.accountId);
    return prepared ? { ...prepared, assetsDirectory: sourceAssets } : null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(publicAssets, { recursive: true, force: true });
  }
}
