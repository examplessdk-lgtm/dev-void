import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import spawn from 'cross-spawn';
import { toSlash } from 'pathslash';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  type IsolatedPlayground,
} from '../../../../test/integration-helpers.ts';
import {
  computeDesiredCloudflareResources,
  parseRootWranglerConfig,
  reconstructExpectedContainers,
  snapshotBindingIdentities,
  snapshotPassthroughIdentities,
  snapshotPassthroughRawFields,
  verifyGeneratedDeployConfig,
} from '../../src/cli/deploy.ts';
import { materializeCloudflareConfig } from '../../src/cloudflare-config.ts';
import { renderVoidConfig } from '../../src/config-write.ts';
import { readConfig } from '../../src/config.ts';
import {
  resolveSandboxConfig,
  sandboxContainerConfig,
  SANDBOX_MIGRATION_TAG,
} from '../../src/sandbox/config.ts';
import { CLOUDFLARE_DEPLOY_BUILD_ENV } from '../../src/shared/env.ts';

// Real-build FP-safety lock for `void deploy --platform cloudflare`. The unit tests drive
// `runCloudflareDeploy` with a STUBBED `vite build` and HAND-WRITTEN emitted configs, so nothing
// there proves the guard's core premise: that a REAL `@cloudflare/vite-plugin` + wrangler build
// emits exactly the shape `verifyGeneratedDeployConfig` reconstructs, adding nothing that would
// false-positive a legitimate deploy. This test runs a real `vite build` of the richest playground
// (kitchen-sink: D1 + KV + R2 + AI + sandbox/containers + cron + queue), reconstructs `expected`
// with the SAME exported builders `runCloudflareDeploy` uses (steps 1 + 5/6), and asserts the real
// emission PASSES the real guard unmodified. A future plugin/wrangler upgrade that adds a field
// would break this lock instead of surfacing as a production deploy-blocking false positive.
//
// Negative cases start from the SAME real emitted artifact, apply one minimal tamper in memory,
// write it back to the path the guard reads, and assert it is REJECTED — real-shape teeth.

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SOURCE_PLAYGROUND = 'playground/kitchen-sink';
let playground: IsolatedPlayground;
let pg = '';
let emittedPath = '';

// Real-SHAPED ids the guard treats as genuine (`isRealD1Id` UUID / `isRealKvId` 32-hex).
// Provisioning writes real ids into the root config before the build, and the build merges the
// root config into the emitted artifact, so an overlaid `cloudflare` config carrying these ids
// yields an emitted artifact whose id-bearing bindings match the pinned snapshot — the exact
// clean-deploy condition the guard authorizes.
const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const WORKER_NAME = 'void-kitchen-sink';
const REAL_D1_ID = '52b3bbc7-c473-4b26-9486-1345f5de61c4';
const REAL_KV_ID = '7c07b54c9f2a4d1e8b3f6a0c153aa11a';
const REAL_ISR_CACHE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OTHER_D1_ID = '11111111-2222-3333-4444-555555555555';
const R2_BUCKET_NAME = 'void-kitchen-sink-storage';

// The overlaid Cloudflare config. kitchen-sink ships no authored Cloudflare bindings (it relies on void.config.ts +
// inference), so the test declares `account_id`, `name`, and real-shaped ids for every
// id-bearing binding the source uses, then removes the isolated playground on teardown.
const OVERLAY_WRANGLER = {
  name: WORKER_NAME,
  account_id: ACCOUNT_ID,
  compatibility_date: '2026-02-24',
  d1_databases: [{ binding: 'DB', database_name: 'void-kitchen-sink-db', database_id: REAL_D1_ID }],
  // kitchen-sink enables ISR (`pages/revalidate.server.ts`), so `computeDesiredCloudflareResources`
  // adds a SECOND KV binding — `ISR_CACHE` — beyond the app's own `KV`. Pin a distinct real-shaped id
  // for it too, so the emitted artifact carries both KV namespaces and the FP-lock covers the two-KV
  // shape a real provisioned ISR deploy builds (not just the single app KV).
  kv_namespaces: [
    { binding: 'KV', id: REAL_KV_ID },
    { binding: 'ISR_CACHE', id: REAL_ISR_CACHE_ID },
  ],
  r2_buckets: [{ binding: 'STORAGE', bucket_name: R2_BUCKET_NAME }],
};

// The `expected` payload `runCloudflareDeploy` (steps 5/6) threads into the guard, rebuilt here from
// the same exported builders.
type ExpectedPayload = Parameters<typeof verifyGeneratedDeployConfig>[1];

// The pristine real emission, parsed once and reused (deep-cloned) across every tamper case.
let pristineEmitted: Record<string, unknown> = {};
let expectedPayload: ExpectedPayload;

/** A fresh deep clone of the pristine emitted config, so a tamper never mutates the shared copy. */
function cloneEmitted(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(pristineEmitted)) as Record<string, unknown>;
}

/**
 * Write a tampered emitted config to the exact path the guard reads (via the CF plugin's
 * `.wrangler/deploy/config.json` redirect), run the REAL guard, then restore the pristine emission —
 * even if the assertion throws. No rebuild: the tamper models a compromised build editing the one
 * artifact `wrangler deploy` uploads.
 */
function guardOnTamper(mutate: (config: Record<string, unknown>) => void): {
  ok: boolean;
  reason?: string;
} {
  const tampered = cloneEmitted();
  mutate(tampered);
  writeFileSync(emittedPath, JSON.stringify(tampered));
  try {
    return verifyGeneratedDeployConfig(pg, expectedPayload);
  } finally {
    writeFileSync(emittedPath, JSON.stringify(pristineEmitted));
  }
}

describe('playground/kitchen-sink --platform cloudflare real-build deploy guard', () => {
  beforeAll(async () => {
    playground = createIsolatedPlayground(ROOT, SOURCE_PLAYGROUND);
    pg = playground.root;
    const typedPath = join(pg, 'void.config.ts');
    // A normal deploy syncs the inferred Sandbox before Vite resolves its config.
    // Exercise that existing entry, rather than only the initially empty config.
    const sandbox = resolveSandboxConfig({ sandbox: { instanceType: 'standard-1' } }, pg);
    writeFileSync(
      typedPath,
      renderVoidConfig({
        ...readConfig(pg),
        sandbox: { instanceType: 'standard-1' },
        cloudflare: {
          ...OVERLAY_WRANGLER,
          durable_objects: { bindings: [{ name: sandbox.binding, class_name: sandbox.className }] },
          migrations: [{ tag: SANDBOX_MIGRATION_TAG, new_sqlite_classes: [sandbox.className] }],
          containers: [sandboxContainerConfig(sandbox)],
        },
      }),
    );
    const configPath = materializeCloudflareConfig(pg);
    emittedPath = join(pg, 'dist', 'ssr', 'wrangler.json');

    // Fresh build inputs: drop the previous dist + the stale CF-plugin deploy pointer so the guard
    // trusts only a pointer this build wrote.
    rmSync(join(pg, 'dist'), { recursive: true, force: true });
    rmSync(join(pg, '.wrangler', 'deploy', 'config.json'), { force: true });

    // Reconstruct `expected` EXACTLY as runCloudflareDeploy does (steps 1 + 5/6): the desired set +
    // signals from `computeDesiredCloudflareResources`, and the four snapshots + container set from
    // the root config — captured BEFORE the build, matching the orchestrator's pre-build snapshot.
    // Doing this AFTER the build would let build-time code that rewrote the root config launder a
    // tampered binding set into `expected`, so the FP-safety lock could pass an artifact that
    // production (which snapshots pre-build) would reject.
    const voidConfig = readConfig(pg);
    const { desired, needsAI, needsSandbox, expectedCrons } =
      await computeDesiredCloudflareResources(pg, voidConfig, configPath);
    const rootConfig = parseRootWranglerConfig(configPath);
    expectedPayload = {
      accountId: ACCOUNT_ID,
      workerName: WORKER_NAME,
      desired,
      bindingIdentitySnapshot: snapshotBindingIdentities(rootConfig),
      passthroughIdentitySnapshot: snapshotPassthroughIdentities(rootConfig),
      passthroughRawFields: snapshotPassthroughRawFields(rootConfig),
      needsAI,
      expectedContainers: reconstructExpectedContainers(voidConfig, pg, rootConfig, needsSandbox),
      expectedCrons,
    };

    const result = spawn.sync('vp', ['build'], {
      cwd: pg,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, [CLOUDFLARE_DEPLOY_BUILD_ENV]: '1' },
    });
    expect(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`).toBe(0);

    pristineEmitted = JSON.parse(readFileSync(emittedPath, 'utf-8')) as Record<string, unknown>;
  });

  afterAll(() => {
    playground?.cleanup();
  });

  // --- Proof this is a REAL build (not a hand-written facsimile) ---------------------------------

  it('emits the CF-plugin deploy pointer the guard follows', () => {
    const pointer = JSON.parse(
      readFileSync(join(pg, '.wrangler', 'deploy', 'config.json'), 'utf-8'),
    ) as { configPath?: string };
    // The CF plugin writes this with node:path.relative, so the separator is PLATFORM-NATIVE
    // (`..\..\dist\ssr\wrangler.json` on Windows). The guard that consumes it resolves through
    // pathslash, which normalizes backslashes, so compare the normalized form rather than pinning
    // a POSIX literal that only holds on one platform.
    expect(toSlash(normalize(pointer.configPath ?? ''))).toBe('../../dist/ssr/wrangler.json');
  });

  it('merges the pinned account, worker name, and real binding ids into the emitted artifact', () => {
    expect(pristineEmitted.account_id).toBe(ACCOUNT_ID);
    expect(pristineEmitted.name).toBe(WORKER_NAME);
    expect(pristineEmitted.d1_databases).toContainEqual(
      expect.objectContaining({ binding: 'DB', database_id: REAL_D1_ID }),
    );
    expect(pristineEmitted.kv_namespaces).toContainEqual(
      expect.objectContaining({ binding: 'KV', id: REAL_KV_ID }),
    );
    // The SECOND KV binding an ISR app requires — the guard's clean-pass below therefore exercises
    // the two-KV shape a real provisioned ISR deploy builds, not just the single app KV.
    expect(pristineEmitted.kv_namespaces).toContainEqual(
      expect.objectContaining({ binding: 'ISR_CACHE', id: REAL_ISR_CACHE_ID }),
    );
    expect(pristineEmitted.r2_buckets).toContainEqual(
      expect.objectContaining({ binding: 'STORAGE', bucket_name: R2_BUCKET_NAME }),
    );
  });

  it('emits the sandbox container, injected AI binding, cron trigger, and queue bindings', () => {
    expect(pristineEmitted.containers).toHaveLength(1);
    expect(pristineEmitted.containers).toContainEqual(
      expect.objectContaining({ name: 'void-sandbox-v1', class_name: 'SandboxV1' }),
    );
    expect(pristineEmitted.ai).toEqual({ binding: 'AI' });
    expect(pristineEmitted.triggers).toEqual({ crons: ['* * * * *'] });
    const queues = pristineEmitted.queues as {
      producers: Array<{ queue: string }>;
      consumers: Array<{ queue: string }>;
    };
    expect(queues.producers).toContainEqual(expect.objectContaining({ queue: 'demo-queue' }));
    expect(queues.consumers).toContainEqual(expect.objectContaining({ queue: 'demo-queue' }));
  });

  it('reconstructs a container set byte-identical to the emitted sandbox container', () => {
    // The highest-value FP-safety lock: `reconstructExpectedContainers` (a pure pre-build function)
    // must produce EXACTLY what the CF plugin emitted, or every sandbox deploy would false-positive.
    const actual = structuredClone(pristineEmitted.containers) as Array<{
      images: { default: { dockerfile: string } };
    }>;
    for (const container of actual) {
      container.images.default.dockerfile = resolve(
        pg,
        'dist/ssr',
        container.images.default.dockerfile,
      );
    }
    expect(expectedPayload.expectedContainers).toEqual(actual);
  });

  // --- Positive: the real emission passes the real guard unmodified (FP-lock) -------------------

  it('the real emitted config passes verifyGeneratedDeployConfig unmodified', () => {
    expect(verifyGeneratedDeployConfig(pg, expectedPayload)).toEqual({ ok: true });
  });

  // --- Negative: the SAME real emission, minimally tampered, is rejected (teeth) -----------------

  it('rejects an injected container application', () => {
    const result = guardOnTamper((config) => {
      (config.containers as Array<unknown>).push({ class_name: 'Evil', image: '/attacker' });
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/container application .*injected/i);
  });

  it('rejects a swapped D1 database_id', () => {
    const result = guardOnTamper((config) => {
      (config.d1_databases as Array<{ database_id: string }>)[0].database_id = OTHER_D1_ID;
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/identity|tampered|flattened/i);
  });

  it('rejects an injected id-bearing binding (EXTRA_DB)', () => {
    const result = guardOnTamper((config) => {
      (config.d1_databases as Array<unknown>).push({
        binding: 'EXTRA_DB',
        database_name: 'attacker-db',
        database_id: OTHER_D1_ID,
      });
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not present before the build|injected/i);
  });

  it('rejects an injected cron schedule', () => {
    const result = guardOnTamper((config) => {
      (config.triggers as { crons: Array<string> }).crons.push('0 0 * * *');
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/cron trigger schedule .*injected/i);
  });

  it('rejects an injected services binding', () => {
    const result = guardOnTamper((config) => {
      config.services = [{ binding: 'EVIL_SVC', service: 'attacker-worker' }];
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/services binding .*injected/i);
  });

  it('rejects an injected routes entry', () => {
    const result = guardOnTamper((config) => {
      config.routes = [{ pattern: 'evil.example.com/*', zone_name: 'example.com' }];
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/routes value does not match/i);
  });
});
