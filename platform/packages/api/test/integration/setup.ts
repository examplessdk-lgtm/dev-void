import { afterEach, vi } from 'vite-plus/test';

// A JSON deploy keeps writing to the database after its route returns, until
// its NDJSON body is read (routes/deploy.ts runs that pipeline detached). A test
// that checks only the status would leave the deploy running into the next
// test, where its project-then-deployment row locks deadlock with
// clearTables' deployment-then-project deletes on PostgreSQL. Finish every
// unread deploy stream before the next test's setup runs.
const unreadDeployStreams = new Set<Response>();
const NativeResponse = globalThis.Response;
globalThis.Response = class TrackedResponse extends NativeResponse {
  constructor(body?: BodyInit | null, init?: ResponseInit) {
    super(body, init);
    if (
      body instanceof ReadableStream &&
      this.headers.get('content-type')?.includes('application/x-ndjson')
    ) {
      unreadDeployStreams.add(this);
    }
  }
} as typeof Response;

afterEach(async () => {
  const pending = [...unreadDeployStreams];
  unreadDeployStreams.clear();
  await Promise.all(
    pending.map(async (response) => {
      if (response.bodyUsed || !response.body || response.body.locked) {
        return;
      }
      // A receipt stream only polls the database; cancelling stops it.
      if (response.headers.has('x-void-deployment-id')) {
        await response.body.cancel().catch(() => {});
        return;
      }
      // The inline pipeline closes its stream after its last database write.
      await response.text().catch(() => {});
    }),
  );
});

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
