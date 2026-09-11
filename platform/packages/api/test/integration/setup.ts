import { vi } from 'vite-plus/test';

// Polyfill the Cloudflare-Workers-only `FixedLengthStream` global for Node,
// so code paths that rely on it (e.g. `streamStaticAssetToR2` in assets.ts)
// can be exercised under the integration harness. Semantics mirror workerd:
// a TransformStream that passes bytes through unchanged and errors the
// writable side if the total written bytes don't equal `expectedLength` at
// close time. A short stream (close before reaching `expectedLength`) and a
// long stream (write past `expectedLength`) both surface as TypeError with
// "length" in the message, which the production error mapper wraps as
// `MultipartParseError`.
if ((globalThis as { FixedLengthStream?: unknown }).FixedLengthStream === undefined) {
  class NodeFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
    constructor(expectedLength: number | bigint) {
      const expected = typeof expectedLength === 'bigint' ? Number(expectedLength) : expectedLength;
      let written = 0;
      super({
        transform(chunk, controller) {
          written += chunk.byteLength;
          if (written > expected) {
            controller.error(
              new TypeError(`FixedLengthStream: wrote more bytes than expected length ${expected}`),
            );
            return;
          }
          controller.enqueue(chunk);
        },
        flush(controller) {
          if (written !== expected) {
            controller.error(
              new TypeError(`FixedLengthStream: expected ${expected} bytes but got ${written}`),
            );
          }
        },
      });
    }
  }
  (globalThis as { FixedLengthStream?: unknown }).FixedLengthStream = NodeFixedLengthStream;
}

// Shared test db reference — set by setupEnv(), read by the createDb mock.
// When null, createDb falls through to the real implementation.
let testDb: import('../../src/db.ts').Db | null = null;

export function setTestDb(db: import('../../src/db.ts').Db) {
  testDb = db;
}

export function clearTestDb() {
  testDb = null;
}

// Per-test override hook for the imported `getProject` helper. Tests that
// need to simulate row-state changes between two reads (e.g. TOCTOU
// regression coverage for the upload-urls FOR SHARE lock) can register a
// callback here to intercept calls. When unset, the original `getProject`
// runs unchanged.
type GetProjectFn = typeof import('../../src/db.ts').getProject;
let getProjectOverride:
  | ((args: {
      original: GetProjectFn;
      argsList: Parameters<GetProjectFn>;
    }) => ReturnType<GetProjectFn>)
  | null = null;

export function setGetProjectOverride(
  override:
    | ((args: {
        original: GetProjectFn;
        argsList: Parameters<GetProjectFn>;
      }) => ReturnType<GetProjectFn>)
    | null,
) {
  getProjectOverride = override;
}

vi.mock('../../src/db', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/db.ts')>();
  return {
    ...mod,
    createDb: (...args: [string]) => testDb ?? mod.createDb(...args),
    getProject: ((...argsList: Parameters<GetProjectFn>) => {
      if (getProjectOverride) {
        return getProjectOverride({ original: mod.getProject, argsList });
      }
      return mod.getProject(...argsList);
    }) as GetProjectFn,
  };
});
