import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  perDeployContainerApplicationName,
  provisionPerDeployContainer,
} from '../../src/provisioning/containers.ts';
import { SANDBOX_DRAIN_STATE_KEY } from '../../src/sandbox-drain.ts';

const ACCOUNT = 'acc_test';
const TOKEN = 'token_test';
const DISPATCH = 'void-users';
const SCRIPT = 'user-myapp-dpl_abc';
const APP_NAME = 'proj-myapp-dpl-abc-void-sandbox';
const BINDING_NAME = 'SANDBOX';
const CLASS_NAME = 'Sandbox';
const NAMESPACE_ID = 'ns_user_myapp_dpl_abc_Sandbox';
const SANDBOX_IMAGE = 'registry.cloudflare.com/sandbox:1.0.0';
const OPEN_ROUTING = {
  get: async () => null,
} as unknown as Pick<KVNamespace, 'get'>;

function cfSuccess(result: unknown): Response {
  return Response.json({ success: true, errors: [], result });
}

function cfError(message: string, status = 400, code = 1000): Response {
  return Response.json({ success: false, errors: [{ code, message }] }, { status });
}

describe('perDeployContainerApplicationName', () => {
  it('lowercases and converts underscores to dashes', () => {
    expect(perDeployContainerApplicationName('proj_ABC', 'dpl_XYZ', 'My_Sandbox')).toBe(
      'proj-abc-dpl-xyz-my-sandbox',
    );
  });

  it('produces unique-per-deploy names', () => {
    const a = perDeployContainerApplicationName('proj_x', 'dpl_1', 'sb');
    const b = perDeployContainerApplicationName('proj_x', 'dpl_2', 'sb');
    expect(a).not.toBe(b);
  });
});

describe('provisionPerDeployContainer', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('happy path: looks up DO namespace via per-script bindings, then POSTs container app bound to it', async () => {
    // 1) GET /scripts/{name}/bindings → returns same-script DO binding with namespace_id
    fetchMock.mockResolvedValueOnce(
      cfSuccess([
        {
          type: 'durable_object_namespace',
          name: BINDING_NAME,
          class_name: CLASS_NAME,
          namespace_id: NAMESPACE_ID,
        },
      ]),
    );
    // 2) POST /containers/applications → returns the new app
    fetchMock.mockResolvedValueOnce(cfSuccess({ id: 'app_test', name: APP_NAME }));

    const result = await provisionPerDeployContainer(
      ACCOUNT,
      TOKEN,
      DISPATCH,
      SCRIPT,
      APP_NAME,
      BINDING_NAME,
      CLASS_NAME,
      { image: SANDBOX_IMAGE, instanceType: 'lite', maxInstances: 20 },
      OPEN_ROUTING,
    );

    expect(result).toEqual({ namespaceId: NAMESPACE_ID, containerApplicationId: 'app_test' });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [bindingsUrl, bindingsInit] = fetchMock.mock.calls[0]!;
    expect(String(bindingsUrl)).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/dispatch/namespaces/${DISPATCH}/scripts/${SCRIPT}/bindings`,
    );
    expect((bindingsInit as RequestInit | undefined)?.method ?? 'GET').toBe('GET');

    const [createUrl, createInit] = fetchMock.mock.calls[1]!;
    expect(String(createUrl)).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/containers/applications`,
    );
    const init = createInit as RequestInit;
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      name: APP_NAME,
      configuration: { image: SANDBOX_IMAGE, instance_type: 'lite' },
      max_instances: 20,
      durable_objects: { namespace_id: NAMESPACE_ID },
    });
  });

  it('on container POST 409 with matching namespace_id: looks up + reuses the existing application', async () => {
    fetchMock.mockResolvedValueOnce(
      cfSuccess([
        {
          type: 'durable_object_namespace',
          name: BINDING_NAME,
          class_name: CLASS_NAME,
          namespace_id: NAMESPACE_ID,
        },
      ]),
    );
    // POST returns 409 — concurrent-create race or partial-failure replay.
    fetchMock.mockResolvedValueOnce(cfError('already exists', 409));
    // findContainerApplication GET returns the existing app on the SAME namespace.
    fetchMock.mockResolvedValueOnce(
      cfSuccess([
        {
          id: 'app_existing',
          name: APP_NAME,
          durable_objects: { namespace_id: NAMESPACE_ID },
        },
      ]),
    );

    const result = await provisionPerDeployContainer(
      ACCOUNT,
      TOKEN,
      DISPATCH,
      SCRIPT,
      APP_NAME,
      BINDING_NAME,
      CLASS_NAME,
      { image: SANDBOX_IMAGE },
      OPEN_ROUTING,
    );

    expect(result).toEqual({ namespaceId: NAMESPACE_ID, containerApplicationId: 'app_existing' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('on container POST 409 with DIFFERENT namespace_id: refuses to reuse, throws', async () => {
    fetchMock.mockResolvedValueOnce(
      cfSuccess([
        {
          type: 'durable_object_namespace',
          name: BINDING_NAME,
          class_name: CLASS_NAME,
          namespace_id: NAMESPACE_ID,
        },
      ]),
    );
    fetchMock.mockResolvedValueOnce(cfError('already exists', 409));
    fetchMock.mockResolvedValueOnce(
      cfSuccess([
        {
          id: 'app_other',
          name: APP_NAME,
          durable_objects: { namespace_id: 'ns_other' },
        },
      ]),
    );

    await expect(
      provisionPerDeployContainer(
        ACCOUNT,
        TOKEN,
        DISPATCH,
        SCRIPT,
        APP_NAME,
        BINDING_NAME,
        CLASS_NAME,
        { image: SANDBOX_IMAGE },
        OPEN_ROUTING,
      ),
    ).rejects.toThrow(/refusing to reuse/i);
  });

  it('eventually finds the DO namespace after a transient miss (retry/backoff absorbs propagation lag)', async () => {
    // First bindings GET returns no matching binding — the retry helper sees
    // `undefined` and tries again.
    fetchMock.mockImplementationOnce(async () => cfSuccess([]));
    // Second bindings GET returns the binding.
    fetchMock.mockImplementationOnce(async () =>
      cfSuccess([
        {
          type: 'durable_object_namespace',
          name: BINDING_NAME,
          class_name: CLASS_NAME,
          namespace_id: NAMESPACE_ID,
        },
      ]),
    );
    // Container POST succeeds.
    fetchMock.mockImplementationOnce(async () => cfSuccess({ id: 'app_x', name: APP_NAME }));

    const result = await provisionPerDeployContainer(
      ACCOUNT,
      TOKEN,
      DISPATCH,
      SCRIPT,
      APP_NAME,
      BINDING_NAME,
      CLASS_NAME,
      { image: SANDBOX_IMAGE },
      OPEN_ROUTING,
    );

    expect(result).toEqual({ namespaceId: NAMESPACE_ID, containerApplicationId: 'app_x' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('checks the drain gate immediately before creating an application', async () => {
    fetchMock.mockResolvedValueOnce(
      cfSuccess([
        {
          type: 'durable_object_namespace',
          name: BINDING_NAME,
          class_name: CLASS_NAME,
          namespace_id: NAMESPACE_ID,
        },
      ]),
    );
    const routing = {
      get: vi.fn(async (key: string) => {
        expect(key).toBe(SANDBOX_DRAIN_STATE_KEY);
        return JSON.stringify({
          version: 1,
          generation: 'generation-1',
          state: 'draining',
          startedAt: '2026-09-16T00:00:00.000Z',
          updatedAt: '2026-09-16T00:00:00.000Z',
        });
      }),
    };

    await expect(
      provisionPerDeployContainer(
        ACCOUNT,
        TOKEN,
        DISPATCH,
        SCRIPT,
        APP_NAME,
        BINDING_NAME,
        CLASS_NAME,
        { image: SANDBOX_IMAGE },
        routing as unknown as Pick<KVNamespace, 'get'>,
      ),
    ).rejects.toThrow(/disabled by the platform drain gate/i);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('deletes a late-created application when the drain gate closes during creation', async () => {
    fetchMock
      .mockResolvedValueOnce(
        cfSuccess([
          {
            type: 'durable_object_namespace',
            name: BINDING_NAME,
            class_name: CLASS_NAME,
            namespace_id: NAMESPACE_ID,
          },
        ]),
      )
      .mockResolvedValueOnce(cfSuccess({ id: 'app_late', name: APP_NAME }))
      .mockResolvedValueOnce(cfSuccess(null));
    const routing = {
      get: vi
        .fn<(key: string) => Promise<string | null>>()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          JSON.stringify({
            version: 1,
            generation: 'generation-1',
            state: 'draining',
            startedAt: '2026-09-16T00:00:00.000Z',
            updatedAt: '2026-09-16T00:00:01.000Z',
          }),
        ),
    };

    await expect(
      provisionPerDeployContainer(
        ACCOUNT,
        TOKEN,
        DISPATCH,
        SCRIPT,
        APP_NAME,
        BINDING_NAME,
        CLASS_NAME,
        { image: SANDBOX_IMAGE },
        routing as unknown as Pick<KVNamespace, 'get'>,
      ),
    ).rejects.toThrow(/disabled by the platform drain gate/i);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [deleteUrl, deleteInit] = fetchMock.mock.calls[2]!;
    expect(String(deleteUrl)).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/containers/applications/app_late`,
    );
    expect((deleteInit as RequestInit).method).toBe('DELETE');
  });
});
