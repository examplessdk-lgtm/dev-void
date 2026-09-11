import { describe, expect, it } from 'vite-plus/test';
import type { ApiEnv } from '../../src/env.ts';
import { cancelContainerBuildDos } from '../../src/github/cancel-builds.ts';

// A recording BuildManager namespace stand-in: records every (buildId, reason)
// pair its `cancelBuild` RPC received. `idFromName` round-trips the build id
// through the stub so the assertion can recover which build was addressed. Each
// namespace gets its OWN recorder so a routing test can prove WHICH class
// (base vs large) received the cancel.
function recordingNamespace(): {
  ns: DurableObjectNamespace;
  cancels: Array<{ id: string; reason: string }>;
} {
  const cancels: Array<{ id: string; reason: string }> = [];
  const ns = {
    idFromName: (name: string) => ({ toString: () => name }),
    get: (idObj: { toString: () => string }) => ({
      cancelBuild: async (reason: string) => {
        cancels.push({ id: idObj.toString(), reason });
      },
    }),
  } as unknown as DurableObjectNamespace;
  return { ns, cancels };
}

describe('cancelContainerBuildDos', () => {
  it('routes a standard-4 (paid) build to BUILD_MANAGER_LARGE and a free/null build to BUILD_MANAGER', async () => {
    const base = recordingNamespace();
    const large = recordingNamespace();
    const env = {
      BUILD_MANAGER: base.ns,
      BUILD_MANAGER_LARGE: large.ns,
    } as unknown as ApiEnv['Bindings'];

    await cancelContainerBuildDos(
      env,
      [
        { id: 'bld_paid', executor: 'container', instance_type: 'standard-4' },
        { id: 'bld_free', executor: 'container', instance_type: null },
      ],
      'test cancel',
    );

    // The paid build's cancel landed on the LARGE class — and ONLY there.
    expect(large.cancels).toEqual([{ id: 'bld_paid', reason: 'test cancel' }]);
    // The free/null build's cancel landed on the BASE class — and ONLY there.
    expect(base.cancels).toEqual([{ id: 'bld_free', reason: 'test cancel' }]);
  });

  it('routes the explicit free instance (standard-3) to BUILD_MANAGER', async () => {
    const base = recordingNamespace();
    const large = recordingNamespace();
    const env = {
      BUILD_MANAGER: base.ns,
      BUILD_MANAGER_LARGE: large.ns,
    } as unknown as ApiEnv['Bindings'];

    await cancelContainerBuildDos(env, [
      { id: 'bld_free', executor: 'container', instance_type: 'standard-3' },
    ]);

    expect(base.cancels).toEqual([{ id: 'bld_free', reason: 'build cancelled' }]);
    expect(large.cancels).toEqual([]);
  });

  it('skips non-container builds (github_actions have no DO)', async () => {
    const base = recordingNamespace();
    const large = recordingNamespace();
    const env = {
      BUILD_MANAGER: base.ns,
      BUILD_MANAGER_LARGE: large.ns,
    } as unknown as ApiEnv['Bindings'];

    await cancelContainerBuildDos(env, [
      { id: 'bld_actions', executor: 'github_actions', instance_type: 'standard-4' },
    ]);

    expect(base.cancels).toEqual([]);
    expect(large.cancels).toEqual([]);
  });

  it('swallows a per-build cancel failure and keeps going (best-effort, never throws)', async () => {
    // The base namespace throws on cancel; the large one records. A failure for
    // the first build must NOT abort the loop or propagate.
    const throwingBase = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({
        cancelBuild: async () => {
          throw new Error('DO unreachable');
        },
      }),
    } as unknown as DurableObjectNamespace;
    const large = recordingNamespace();
    const env = {
      BUILD_MANAGER: throwingBase,
      BUILD_MANAGER_LARGE: large.ns,
    } as unknown as ApiEnv['Bindings'];

    await expect(
      cancelContainerBuildDos(env, [
        { id: 'bld_free', executor: 'container', instance_type: null },
        { id: 'bld_paid', executor: 'container', instance_type: 'standard-4' },
      ]),
    ).resolves.toBeUndefined();

    // The second (large) cancel still ran despite the first throwing.
    expect(large.cancels).toEqual([{ id: 'bld_paid', reason: 'build cancelled' }]);
  });
});
