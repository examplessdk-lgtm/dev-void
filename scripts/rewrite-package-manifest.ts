import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

export function toPublicPackageName(packageName: string): string {
  if (packageName === "@void-sdk/void") return "void";
  if (packageName.startsWith("@void-sdk/")) {
    return packageName.replace(/^@void-sdk\//, "@void/");
  }
  return packageName;
}

function readJson(filePath: string) {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function writeJson(filePath: string, value: Record<string, any>) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function getWorkspaceVersion(relativePath: string) {
  return readJson(join(repoRoot, relativePath)).version;
}

export function rewriteManifestForPublish(pkg: Record<string, any>): Record<string, any> {
  const next = structuredClone(pkg);
  const voidVersion = getWorkspaceVersion("packages/void/package.json");

  switch (pkg.name) {
    case "@void-sdk/react":
    case "@void-sdk/vue":
    case "@void-sdk/svelte":
    case "@void-sdk/solid":
    case "@void-sdk/md":
      if (next.peerDependencies?.void) {
        next.peerDependencies.void = `^${voidVersion}`;
      }
      break;
    case "@void-sdk/void": {
      const peerDependencies: Record<string, any> = {};
      for (const [name, spec] of Object.entries(next.peerDependencies ?? {})) {
        if (name.startsWith("@void-sdk/")) {
          const version = getWorkspaceVersion(
            `packages/${name.replace(/^@void-sdk\//, "")}/package.json`,
          );
          peerDependencies[toPublicPackageName(name)] = `^${version}`;
          continue;
        }
        peerDependencies[name] = spec;
      }
      next.peerDependencies = peerDependencies;

      const peerDependenciesMeta: Record<string, any> = {};
      for (const [name, meta] of Object.entries(next.peerDependenciesMeta ?? {})) {
        peerDependenciesMeta[toPublicPackageName(name)] = meta;
      }
      next.peerDependenciesMeta = peerDependenciesMeta;
      break;
    }
  }

  return next;
}

function runRewrite(packageDir: string) {
  const packageJsonPath = join(packageDir, "package.json");
  const original = readFileSync(packageJsonPath, "utf-8");
  const pkg = JSON.parse(original) as Record<string, any>;
  writeJson(packageJsonPath, rewriteManifestForPublish(pkg));
}

async function main() {
  const packageDir = process.cwd();
  runRewrite(packageDir);
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  await main();
}
