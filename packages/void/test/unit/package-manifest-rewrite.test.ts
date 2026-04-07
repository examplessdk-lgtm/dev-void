import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  rewriteManifestForPublish,
  toPublicPackageName,
} from "../../../../scripts/rewrite-package-manifest.js";

function readPackageJson(relativePath: string): Record<string, any> {
  const root = join(import.meta.dirname, "../../../../");
  return JSON.parse(readFileSync(join(root, relativePath), "utf-8"));
}

describe("rewrite-package-manifest", () => {
  it("maps preview package names to public package names", () => {
    expect(toPublicPackageName("@void-sdk/void")).toBe("void");
    expect(toPublicPackageName("@void-sdk/react")).toBe("@void/react");
    expect(toPublicPackageName("vite")).toBe("vite");
  });

  it("rewrites adapter peerDependencies to public void semver", () => {
    const reactManifest = readPackageJson("packages/react/package.json");
    const voidManifest = readPackageJson("packages/void/package.json");
    const rewritten = rewriteManifestForPublish(reactManifest);

    expect(rewritten.peerDependencies.void).toBe(`^${voidManifest.version}`);
  });

  it("rewrites void optional framework peers to public names", () => {
    const voidManifest = readPackageJson("packages/void/package.json");
    const rewritten = rewriteManifestForPublish(voidManifest);

    expect(rewritten.peerDependencies["@void/react"]).toBe("^0.2.3");
    expect(rewritten.peerDependencies["@void/vue"]).toBe("^0.2.3");
    expect(rewritten.peerDependencies["@void/svelte"]).toBe("^0.2.3");
    expect(rewritten.peerDependencies["@void/solid"]).toBe("^0.2.3");
    expect(rewritten.peerDependencies["@void/md"]).toBe("^0.2.3");
    expect(rewritten.peerDependenciesMeta["@void/react"]).toEqual({ optional: true });
    expect(Object.keys(rewritten.peerDependencies)).not.toContain("@void-sdk/react");
    expect(Object.keys(rewritten.peerDependenciesMeta)).not.toContain("@void-sdk/react");
  });
});
