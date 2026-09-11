import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { Db } from '../../src/db.ts';
import { provisionBindings } from '../../src/provisioning/provision.ts';
import type { DeployManifest, Resource } from '../../src/types.ts';

// Mock the CF API module
vi.mock('../../src/provisioning/cloudflare-api', () => ({
  createD1Database: vi.fn().mockResolvedValue({ uuid: 'd1-uuid-123', name: 'test-DB' }),
  createKVNamespace: vi.fn().mockResolvedValue({ id: 'kv-id-456', title: 'test-KV' }),
  createR2Bucket: vi.fn().mockResolvedValue({ name: 'test-STORAGE' }),
  createQueue: vi.fn().mockResolvedValue({ queue_id: 'queue-id-789', queue_name: 'test-queue' }),
  deleteD1Database: vi.fn().mockResolvedValue(undefined),
  deleteKVNamespace: vi.fn().mockResolvedValue(undefined),
  deleteR2Bucket: vi.fn().mockResolvedValue(undefined),
  deleteQueue: vi.fn().mockResolvedValue(undefined),
  getD1DatabaseByName: vi.fn().mockResolvedValue({ uuid: 'd1-looked-up', name: 'test-DB' }),
  getKVNamespaceByTitle: vi.fn().mockResolvedValue({ id: 'kv-looked-up', title: 'test-KV' }),
  getQueueByName: vi.fn().mockResolvedValue({ queue_id: 'queue-looked-up', queue_name: 'test-q' }),
}));

// Mock db module
vi.mock('../../src/db', () => ({
  getProjectResources: vi.fn().mockResolvedValue([]),
  createResource: vi
    .fn()
    .mockImplementation(
      (_db: unknown, projectId: string, type: string, cfId: string, bindingName: string) =>
        Promise.resolve({
          id: `res_mock`,
          project_id: projectId,
          type,
          cf_id: cfId,
          binding_name: bindingName,
          created_at: new Date().toISOString(),
        }),
    ),
}));

import { getProjectResources, createResource } from '../../src/db.ts';
import {
  createD1Database,
  createKVNamespace,
  createR2Bucket,
  createQueue,
  deleteD1Database,
  getD1DatabaseByName,
  getKVNamespaceByTitle,
  getQueueByName,
} from '../../src/provisioning/cloudflare-api.ts';

const ACCOUNT_ID = 'test-account';
const API_TOKEN = 'test-token';
const PROJECT_ID = 'proj_abc123';
const JWT_SECRET = 'test-jwt-secret';
const mockDb = {} as Db;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getProjectResources).mockResolvedValue([]);
});

describe('provisionBindings', () => {
  it('provisions D1 when manifest requires it and no resource exists', async () => {
    const manifest: DeployManifest = { version: 1, bindings: { d1: ['DB'] } };

    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      JWT_SECRET,
      'void-proxy',
    );

    expect(createD1Database).toHaveBeenCalledWith(ACCOUNT_ID, API_TOKEN, 'proj-abc123-db');
    expect(createResource).toHaveBeenCalledWith(mockDb, PROJECT_ID, 'd1', 'd1-uuid-123', 'DB');
    expect(bindings[0]).toEqual({ type: 'd1', name: 'DB', id: 'd1-uuid-123' });
    // + 3 always-injected proxy bindings
    expect(bindings).toHaveLength(4);
  });

  it('rolls back the CF resource it created when the resources-row INSERT fails', async () => {
    const manifest: DeployManifest = { version: 1, bindings: { d1: ['DB'] } };
    // Model a concurrent-teardown FK violation: the row INSERT throws AFTER CF
    // created the D1 database. Without rollback this leaves an orphaned CF object
    // with no durable handle (the cascade-capture sweep never sees it).
    vi.mocked(createResource).mockRejectedValueOnce(new Error('insert failed (FK violation)'));

    await expect(
      provisionBindings(
        mockDb,
        ACCOUNT_ID,
        API_TOKEN,
        PROJECT_ID,
        manifest,
        JWT_SECRET,
        'void-proxy',
      ),
    ).rejects.toThrow('insert failed');

    // CF created it...
    expect(createD1Database).toHaveBeenCalledWith(ACCOUNT_ID, API_TOKEN, 'proj-abc123-db');
    // ...and the rollback deleted exactly that object.
    expect(deleteD1Database).toHaveBeenCalledWith(ACCOUNT_ID, API_TOKEN, 'd1-uuid-123');
  });

  it('does NOT roll back a CF resource adopted via the already-exists lookup', async () => {
    const manifest: DeployManifest = { version: 1, bindings: { d1: ['DB'] } };
    // createCfResource hits "already exists" → lookupCfResource adopts a
    // pre-existing object we do NOT own. Even if the row INSERT then fails, we
    // must not delete someone else's resource.
    vi.mocked(createD1Database).mockRejectedValueOnce(new Error('database already exists'));
    vi.mocked(createResource).mockRejectedValueOnce(new Error('insert failed (FK violation)'));

    await expect(
      provisionBindings(
        mockDb,
        ACCOUNT_ID,
        API_TOKEN,
        PROJECT_ID,
        manifest,
        JWT_SECRET,
        'void-proxy',
      ),
    ).rejects.toThrow('insert failed');

    expect(deleteD1Database).not.toHaveBeenCalled();
  });

  it('provisions KV when manifest requires it', async () => {
    const manifest: DeployManifest = { version: 1, bindings: { kv: ['KV'] } };

    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      JWT_SECRET,
      'void-proxy',
    );

    expect(createKVNamespace).toHaveBeenCalledWith(ACCOUNT_ID, API_TOKEN, 'proj-abc123-kv');
    expect(createResource).toHaveBeenCalledWith(mockDb, PROJECT_ID, 'kv', 'kv-id-456', 'KV');
    expect(bindings[0]).toEqual({ type: 'kv_namespace', name: 'KV', namespace_id: 'kv-id-456' });
    expect(bindings).toHaveLength(4);
  });

  it('provisions R2 when manifest requires it', async () => {
    const manifest: DeployManifest = { version: 1, bindings: { r2: ['STORAGE'] } };

    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      JWT_SECRET,
      'void-proxy',
    );

    expect(createR2Bucket).toHaveBeenCalledWith(ACCOUNT_ID, API_TOKEN, 'proj-abc123-storage');
    expect(createResource).toHaveBeenCalledWith(
      mockDb,
      PROJECT_ID,
      'r2',
      'test-STORAGE',
      'STORAGE',
    );
    expect(bindings[0]).toEqual({
      type: 'r2_bucket',
      name: 'STORAGE',
      bucket_name: 'test-STORAGE',
    });
    expect(bindings).toHaveLength(4);
  });

  it('provisions queue and stores queue_id (UUID) as cf_id', async () => {
    const manifest: DeployManifest = {
      version: 3,
      bindings: {},
      queues: [{ name: 'emails', bindingName: 'QUEUE_EMAILS' }],
    };

    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      JWT_SECRET,
      'void-proxy',
    );

    expect(createQueue).toHaveBeenCalledWith(ACCOUNT_ID, API_TOKEN, 'proj-abc123-emails');
    expect(createResource).toHaveBeenCalledWith(
      mockDb,
      PROJECT_ID,
      'queue',
      'queue-id-789',
      'emails',
    );
    expect(bindings[0]).toEqual({
      type: 'queue',
      name: 'QUEUE_EMAILS',
      queue_name: 'proj-abc123-emails',
      queue_id: 'queue-id-789',
    });
    expect(bindings).toHaveLength(4);
  });

  it('skips provisioning when resources already exist', async () => {
    const existingResources: Array<Resource> = [
      {
        id: 'res_existing',
        project_id: PROJECT_ID,
        type: 'd1',
        cf_id: 'existing-d1-id',
        binding_name: 'DB',
        created_at: new Date().toISOString(),
        metadata: {},
      },
    ];
    vi.mocked(getProjectResources).mockResolvedValue(existingResources);

    const manifest: DeployManifest = { version: 1, bindings: { d1: ['DB'] } };
    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      JWT_SECRET,
      'void-proxy',
    );

    expect(createD1Database).not.toHaveBeenCalled();
    expect(createResource).not.toHaveBeenCalled();
    expect(bindings[0]).toEqual({ type: 'd1', name: 'DB', id: 'existing-d1-id' });
    expect(bindings).toHaveLength(4);
  });

  it('handles multiple bindings in one deploy', async () => {
    const manifest: DeployManifest = {
      version: 1,
      bindings: { d1: ['DB'], kv: ['KV'], r2: ['STORAGE'] },
    };

    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      JWT_SECRET,
      'void-proxy',
    );

    expect(createD1Database).toHaveBeenCalledOnce();
    expect(createKVNamespace).toHaveBeenCalledOnce();
    expect(createR2Bucket).toHaveBeenCalledOnce();
    // 3 provisioned + 3 always-injected proxy bindings
    expect(bindings).toHaveLength(6);
    expect(bindings[0]).toEqual({ type: 'd1', name: 'DB', id: 'd1-uuid-123' });
    expect(bindings[1]).toEqual({ type: 'kv_namespace', name: 'KV', namespace_id: 'kv-id-456' });
    expect(bindings[2]).toEqual({
      type: 'r2_bucket',
      name: 'STORAGE',
      bucket_name: 'test-STORAGE',
    });
  });

  it('handles empty manifest (only proxy bindings injected)', async () => {
    const manifest: DeployManifest = { version: 1, bindings: {} };

    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      JWT_SECRET,
      'void-proxy',
    );

    expect(createD1Database).not.toHaveBeenCalled();
    expect(createKVNamespace).not.toHaveBeenCalled();
    expect(createR2Bucket).not.toHaveBeenCalled();
    expect(createResource).not.toHaveBeenCalled();
    // Proxy bindings are always injected
    expect(bindings).toHaveLength(3);
    expect(bindings[0]).toEqual({ type: 'service', name: '__VOID_PROXY', service: 'void-proxy' });
  });

  it('always injects proxy bindings with signed token', async () => {
    const manifest: DeployManifest = { version: 1, bindings: {} };

    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      JWT_SECRET,
      'void-proxy',
    );

    expect(bindings).toHaveLength(3);
    expect(bindings[0]).toEqual({ type: 'service', name: '__VOID_PROXY', service: 'void-proxy' });
    expect(bindings[1]).toEqual({ type: 'plain_text', name: '__PROJECT_ID', text: PROJECT_ID });
    expect(bindings[2].type).toBe('plain_text');
    expect(bindings[2].name).toBe('__VOID_PROXY_TOKEN');
    // Token should be a non-empty string (HMAC signature)
    expect(typeof bindings[2].text).toBe('string');
    expect(bindings[2].text!.length).toBeGreaterThan(0);
  });

  it('injects proxy bindings alongside other provisioned bindings', async () => {
    const manifest: DeployManifest = { version: 1, bindings: { d1: ['DB'], ai: true } };

    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      JWT_SECRET,
      'void-proxy',
    );

    // D1 + 3 proxy bindings
    expect(bindings).toHaveLength(4);
    expect(bindings[0]).toEqual({ type: 'd1', name: 'DB', id: 'd1-uuid-123' });
    expect(bindings[1]).toEqual({ type: 'service', name: '__VOID_PROXY', service: 'void-proxy' });
    expect(bindings[2]).toEqual({ type: 'plain_text', name: '__PROJECT_ID', text: PROJECT_ID });
    expect(bindings[3].name).toBe('__VOID_PROXY_TOKEN');
  });

  it('provisions only missing resources when some already exist', async () => {
    const existingResources: Array<Resource> = [
      {
        id: 'res_existing',
        project_id: PROJECT_ID,
        type: 'd1',
        cf_id: 'existing-d1-id',
        binding_name: 'DB',
        created_at: new Date().toISOString(),
        metadata: {},
      },
    ];
    vi.mocked(getProjectResources).mockResolvedValue(existingResources);

    const manifest: DeployManifest = {
      version: 1,
      bindings: { d1: ['DB'], kv: ['KV'] },
    };

    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      JWT_SECRET,
      'void-proxy',
    );

    expect(createD1Database).not.toHaveBeenCalled();
    expect(createKVNamespace).toHaveBeenCalledOnce();
    // 2 provisioned + 3 always-injected proxy bindings
    expect(bindings).toHaveLength(5);
    expect(bindings[0]).toEqual({ type: 'd1', name: 'DB', id: 'existing-d1-id' });
    expect(bindings[1]).toEqual({ type: 'kv_namespace', name: 'KV', namespace_id: 'kv-id-456' });
  });
});

describe('ensureResource — already exists fallback', () => {
  it("falls back to lookup when D1 create returns 'already exists'", async () => {
    vi.mocked(createD1Database).mockRejectedValueOnce(
      new Error('Cloudflare API error: A database with that name already exists'),
    );

    const manifest: DeployManifest = { version: 1, bindings: { d1: ['DB'] } };
    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      JWT_SECRET,
      'void-proxy',
    );

    expect(createD1Database).toHaveBeenCalledOnce();
    expect(getD1DatabaseByName).toHaveBeenCalledWith(ACCOUNT_ID, API_TOKEN, 'proj-abc123-db');
    expect(createResource).toHaveBeenCalledWith(mockDb, PROJECT_ID, 'd1', 'd1-looked-up', 'DB');
    expect(bindings[0]).toEqual({ type: 'd1', name: 'DB', id: 'd1-looked-up' });
  });

  it("falls back to lookup when KV create returns 'already exists'", async () => {
    vi.mocked(createKVNamespace).mockRejectedValueOnce(
      new Error('Cloudflare API error: A namespace with that title already exists'),
    );

    const manifest: DeployManifest = { version: 1, bindings: { kv: ['KV'] } };
    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      JWT_SECRET,
      'void-proxy',
    );

    expect(createKVNamespace).toHaveBeenCalledOnce();
    expect(getKVNamespaceByTitle).toHaveBeenCalledWith(ACCOUNT_ID, API_TOKEN, 'proj-abc123-kv');
    expect(bindings[0]).toEqual({ type: 'kv_namespace', name: 'KV', namespace_id: 'kv-looked-up' });
  });

  it("falls back to lookup when queue create returns 'already exists'", async () => {
    vi.mocked(createQueue).mockRejectedValueOnce(
      new Error('Cloudflare API error: A queue with that name already exists'),
    );

    const manifest: DeployManifest = {
      version: 3,
      bindings: {},
      queues: [{ name: 'emails', bindingName: 'QUEUE_EMAILS' }],
    };
    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      JWT_SECRET,
      'void-proxy',
    );

    expect(createQueue).toHaveBeenCalledOnce();
    expect(getQueueByName).toHaveBeenCalledWith(ACCOUNT_ID, API_TOKEN, 'proj-abc123-emails');
    expect(bindings[0]).toEqual({
      type: 'queue',
      name: 'QUEUE_EMAILS',
      queue_name: 'proj-abc123-emails',
      queue_id: 'queue-looked-up',
    });
  });

  it("propagates non-'already exists' errors", async () => {
    vi.mocked(createD1Database).mockRejectedValueOnce(
      new Error('Cloudflare API error: rate limit exceeded'),
    );

    const manifest: DeployManifest = { version: 1, bindings: { d1: ['DB'] } };
    await expect(
      provisionBindings(
        mockDb,
        ACCOUNT_ID,
        API_TOKEN,
        PROJECT_ID,
        manifest,
        JWT_SECRET,
        'void-proxy',
      ),
    ).rejects.toThrow('rate limit exceeded');

    expect(getD1DatabaseByName).not.toHaveBeenCalled();
  });
});
