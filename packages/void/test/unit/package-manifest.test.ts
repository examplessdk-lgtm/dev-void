import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'pathslash';
import { describe, expect, it } from 'vite-plus/test';

type PackageJson = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const root = join(import.meta.dirname, '../../../..');

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

const packageRoots = [
  '',
  'docs',
  ...readdirSync(join(root, 'packages'))
    .sort()
    .map((name) => `packages/${name}`),
  ...readdirSync(join(root, 'playground'))
    .sort()
    .map((name) => `playground/${name}`),
].filter((packageRoot) => existsSync(join(root, packageRoot, 'package.json')));

const readPackageJson = (packageDir: string): PackageJson =>
  JSON.parse(readFileSync(join(root, packageDir, 'package.json'), 'utf-8')) as PackageJson;

const packages = packageRoots.map((packageRoot) => ({
  manifest: readPackageJson(packageRoot),
  packageRoot: packageRoot || '.',
}));

const workspacePackageNames = new Set(
  packages.map(({ manifest }) => manifest.name).filter((name) => name != null),
);

const pnpmWorkspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf-8');
const pnpmWorkspaceLines = pnpmWorkspace.split(/\r?\n/u);

const readTopLevelScalar = (key: string) => {
  const match = new RegExp(`^${key}:\\s*(\\S+)`, 'm').exec(pnpmWorkspace);
  return match?.[1]?.trim();
};

const readYamlSectionKeys = (sectionName: string) => {
  const lines = pnpmWorkspaceLines;
  const start = lines.findIndex((line) => line.trimEnd() === `${sectionName}:`);
  if (start === -1) {
    return new Set<string>();
  }

  const keys = new Set<string>();
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !line.startsWith(' ')) {
      break;
    }

    const match = /^ {2}(?:"([^"]+)"|'([^']+)'|([^:#]+)):/u.exec(line);
    if (match) {
      keys.add(match[1] ?? match[2] ?? match[3].trim());
    }
  }
  return keys;
};

const readYamlSectionScalars = (sectionName: string) => {
  const lines = pnpmWorkspaceLines;
  const start = lines.findIndex((line) => line.trimEnd() === `${sectionName}:`);
  if (start === -1) {
    return new Map<string, string>();
  }

  const entries = new Map<string, string>();
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !line.startsWith(' ')) {
      break;
    }

    const match = /^ {2}(?:"([^"]+)"|'([^']+)'|([^:#]+)):\s*(\S.*)$/u.exec(line);
    if (match) {
      entries.set(match[1] ?? match[2] ?? match[3].trim(), match[4].trim());
    }
  }
  return entries;
};

const catalogPackageNames = readYamlSectionKeys('catalog');
const catalogPackageSpecifiers = readYamlSectionScalars('catalog');

describe('package manifests', () => {
  it('uses workspace:* for local workspace package dependencies', () => {
    const violations = [];

    for (const { manifest, packageRoot } of packages) {
      for (const field of dependencyFields) {
        for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
          if (workspacePackageNames.has(name) && specifier !== 'workspace:*') {
            violations.push(`${packageRoot} ${field}.${name} = ${specifier}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('uses catalog: for dependencies managed by the default pnpm catalog', () => {
    const violations = [];

    for (const { manifest, packageRoot } of packages) {
      for (const field of dependencyFields) {
        for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
          const catalogSpecifier = catalogPackageSpecifiers.get(name);
          const isAliasedPeer =
            field === 'peerDependencies' && catalogSpecifier?.startsWith('npm:');
          if (catalogPackageNames.has(name) && !isAliasedPeer && specifier !== 'catalog:') {
            violations.push(`${packageRoot} ${field}.${name} = ${specifier}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('only uses catalog: for packages declared in the default pnpm catalog', () => {
    const violations = [];

    for (const { manifest, packageRoot } of packages) {
      for (const field of dependencyFields) {
        for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
          if (specifier === 'catalog:' && !catalogPackageNames.has(name)) {
            violations.push(`${packageRoot} ${field}.${name}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('does not use npm aliases for public peer dependency ranges', () => {
    const violations = [];

    for (const { manifest, packageRoot } of packages) {
      for (const [name, specifier] of Object.entries(manifest.peerDependencies ?? {})) {
        const catalogSpecifier = catalogPackageSpecifiers.get(name);
        if (
          specifier.startsWith('npm:') ||
          (specifier === 'catalog:' && catalogSpecifier?.startsWith('npm:'))
        ) {
          violations.push(`${packageRoot} peerDependencies.${name} = ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('uses a public Vite peer range for published packages', () => {
    const vitePeers = packages
      .filter(({ packageRoot }) => packageRoot.startsWith('packages/'))
      .filter(({ manifest }) => manifest.peerDependencies?.vite)
      .map(({ manifest, packageRoot }) => [
        manifest.name ?? packageRoot,
        manifest.peerDependencies?.vite,
      ]);

    expect(vitePeers).toEqual([
      ['@void/md', '^8.0.0'],
      ['@void/react', '^8.0.0'],
      ['@void/solid', '^8.0.0'],
      ['@void/svelte', '^8.0.0'],
      ['void', '^8.0.0'],
      ['@void/vue', '^8.0.0'],
    ]);
  });

  it('keeps pnpm catalog additions strict', () => {
    expect(readTopLevelScalar('catalogMode')).toBe('strict');
  });
});
