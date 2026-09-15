import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { describe, expect, it, vi } from 'vite-plus/test';
import {
  activateCloudflareVersion,
  deployCloudflareVersionTriggers,
  encodeCloudflareVersionMessage,
  extractWorkersDevSubdomain,
  normalizeWorkersDevSubdomain,
  parseCloudflareVersionMessage,
  readCloudflareTriggerConfig,
  type CloudflareCommandResult,
} from '../../src/index.ts';

const CURRENT = '11111111-1111-4111-8111-111111111111';
const NEXT = '22222222-2222-4222-8222-222222222222';
const CONCURRENT = '33333333-3333-4333-8333-333333333333';

function ok(stdout = ''): CloudflareCommandResult {
  return { stdout, stderr: '', status: 0 };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function runner(overrides?: {
  status?: CloudflareCommandResult;
  upload?: CloudflareCommandResult;
  bootstrap?: CloudflareCommandResult;
  activate?: CloudflareCommandResult;
  triggers?: CloudflareCommandResult;
  triggerRollback?: CloudflareCommandResult;
  rollback?: CloudflareCommandResult;
  versions?: CloudflareCommandResult;
}) {
  let deployCalls = 0;
  let triggerCalls = 0;
  let statusCalls = 0;
  let activeVersionId: string | null = CURRENT;
  let uploaded = false;
  return vi.fn((args: Array<string>) => {
    if (args[0] === 'deployments') {
      statusCalls++;
      if (statusCalls === 1 && overrides?.status) {
        if (overrides.status.status !== 0) {
          activeVersionId = null;
        }
        return overrides.status;
      }
      return ok(
        JSON.stringify({
          versions: activeVersionId ? [{ version_id: activeVersionId, percentage: 100 }] : [],
        }),
      );
    }
    if (args[0] === 'versions' && args[1] === 'upload') {
      uploaded = true;
      return (
        overrides?.upload ??
        ok(
          `Worker Version ID: ${NEXT}\nVersion Preview Alias URL: https://ready.example.workers.dev`,
        )
      );
    }
    if (args[0] === 'versions' && args[1] === 'deploy') {
      deployCalls++;
      const result =
        deployCalls === 1 ? (overrides?.activate ?? ok()) : (overrides?.rollback ?? ok());
      if (result.status === 0) {
        const active = args.find((argument) => /@100$/.test(argument));
        if (active) {
          activeVersionId = active.slice(0, -4);
        }
      }
      return result;
    }
    if (args[0] === 'versions' && args[1] === 'list') {
      return (
        overrides?.versions ??
        ok(
          JSON.stringify([
            {
              id: CURRENT,
              number: 1,
              annotations: {
                'workers/message': encodeCloudflareVersionMessage([], {
                  workers_dev: true,
                  preview_urls: true,
                  routes: [],
                  crons: ['0 * * * *'],
                  queueConsumers: [],
                  workflows: [],
                }),
              },
            },
            ...(uploaded ? [{ id: NEXT, number: 2, annotations: {} }] : []),
          ]),
        )
      );
    }
    if (args[0] === 'deploy') {
      const result = overrides?.bootstrap ?? ok();
      if (result.status === 0) {
        activeVersionId =
          `${result.stdout}\n${result.stderr}`.match(
            /(?:Worker|Current) Version ID:\s*([0-9a-f-]+)/i,
          )?.[1] ?? activeVersionId;
      }
      return result;
    }
    if (args[0] === 'triggers') {
      triggerCalls++;
      return triggerCalls === 1
        ? (overrides?.triggers ?? ok())
        : (overrides?.triggerRollback ?? ok());
    }
    if (args[0] === 'queues') {
      return ok();
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  });
}

describe('Cloudflare version activation', () => {
  it('links an existing version without publishing routes or Worker settings', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'void-link-version-'));
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        name: 'my-worker',
        account_id: 'account',
        observability: { enabled: false },
        logpush: false,
      }),
    );
    try {
      const base = runner();
      const validateUploadedVersion = vi.fn().mockResolvedValue(undefined);
      const runWrangler = vi.fn((args: Array<string>) => {
        if (args[0] === 'versions' && args[1] === 'deploy') {
          const config = JSON.parse(readFileSync(args[args.indexOf('-c') + 1]!, 'utf8'));
          expect(config).toEqual({ account_id: 'account', name: 'my-worker' });
        }
        return base(args);
      });
      const result = await activateCloudflareVersion({
        runWrangler,
        configPath,
        workerName: 'my-worker',
        verifyUploader: () => true,
        preserveTriggers: true,
        expectedPreviousVersionId: CURRENT,
        validateUploadedVersion,
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => Response.json({ ready: true }),
      });
      expect(result).toMatchObject({ ok: true, previousVersionId: CURRENT, versionId: NEXT });
      expect(validateUploadedVersion).toHaveBeenCalledWith(NEXT);
      expect(
        runWrangler.mock.calls.some(([args]) =>
          ['triggers', 'deploy', 'secret'].includes(args[0]!),
        ),
      ).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not activate a candidate with changed bindings or upload over a changed baseline', async () => {
    const runWrangler = runner();
    await expect(
      activateCloudflareVersion({
        runWrangler,
        workerName: 'my-worker',
        verifyUploader: () => true,
        preserveTriggers: true,
        expectedPreviousVersionId: CURRENT,
        message: encodeCloudflareVersionMessage([]),
        validateUploadedVersion: async () => {
          throw new Error('bindings changed');
        },
      }),
    ).rejects.toThrow('bindings changed');
    expect(
      runWrangler.mock.calls.some(([args]) => args[0] === 'versions' && args[1] === 'deploy'),
    ).toBe(false);
    runWrangler.mockClear();
    expect(
      await activateCloudflareVersion({
        runWrangler,
        workerName: 'my-worker',
        verifyUploader: () => true,
        preserveTriggers: true,
        expectedPreviousVersionId: CONCURRENT,
        message: encodeCloudflareVersionMessage([]),
      }),
    ).toMatchObject({ ok: false, reason: 'deployment-changed' });
    expect(runWrangler.mock.calls.some(([args]) => args[1] === 'upload')).toBe(false);
  });

  it('does not inherit secrets from an unpublished Worker version', async () => {
    const unpublished = '44444444-4444-4444-8444-444444444444';
    const runWrangler = runner({
      versions: ok(
        JSON.stringify([
          { id: CURRENT, number: 1 },
          { id: unpublished, number: 2 },
        ]),
      ),
    });
    await expect(
      activateCloudflareVersion({
        runWrangler,
        workerName: 'my-worker',
        verifyUploader: () => true,
        preserveTriggers: true,
        expectedPreviousVersionId: CURRENT,
        message: encodeCloudflareVersionMessage([]),
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'inheritance-source-changed',
      activeVersionId: unpublished,
    });
    expect(runWrangler.mock.calls.some(([args]) => args[1] === 'upload')).toBe(false);
  });

  it('does not trust an unpublished version with a copied Void annotation', async () => {
    const unpublished = '44444444-4444-4444-8444-444444444444';
    const runWrangler = runner({
      versions: ok(
        JSON.stringify([
          { id: CURRENT, number: 1 },
          {
            id: unpublished,
            number: 2,
            annotations: { 'workers/message': encodeCloudflareVersionMessage([]) },
          },
        ]),
      ),
    });
    await expect(
      activateCloudflareVersion({
        runWrangler,
        workerName: 'my-worker',
        verifyUploader: () => true,
        preserveTriggers: true,
        expectedPreviousVersionId: CURRENT,
        message: encodeCloudflareVersionMessage([]),
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'inheritance-source-changed',
      activeVersionId: unpublished,
    });
    expect(runWrangler.mock.calls.some(([args]) => args[1] === 'upload')).toBe(false);
  });

  it('does not activate when another version is uploaded during secret inheritance', async () => {
    const concurrent = '44444444-4444-4444-8444-444444444444';
    let listed = 0;
    const base = runner();
    const runWrangler = vi.fn((args: Array<string>) => {
      if (args[0] === 'versions' && args[1] === 'list') {
        listed++;
        return ok(
          JSON.stringify(
            listed === 1
              ? [{ id: CURRENT, number: 1 }]
              : [
                  { id: CURRENT, number: 1 },
                  { id: concurrent, number: 2 },
                  { id: NEXT, number: 3 },
                ],
          ),
        );
      }
      return base(args);
    });
    await expect(
      activateCloudflareVersion({
        runWrangler,
        workerName: 'my-worker',
        verifyUploader: () => true,
        preserveTriggers: true,
        expectedPreviousVersionId: CURRENT,
        message: encodeCloudflareVersionMessage([]),
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'inheritance-source-changed' });
    expect(runWrangler.mock.calls.some(([args]) => args[1] === 'deploy')).toBe(false);
  });

  it('detects an intervening version even when it is deleted before the second list', async () => {
    let listed = 0;
    const base = runner();
    const runWrangler = vi.fn((args: Array<string>) => {
      if (args[0] === 'versions' && args[1] === 'list') {
        listed++;
        return ok(
          JSON.stringify(
            listed === 1
              ? [{ id: CURRENT, number: 1 }]
              : [
                  { id: CURRENT, number: 1 },
                  { id: NEXT, number: 3 },
                ],
          ),
        );
      }
      return base(args);
    });
    await expect(
      activateCloudflareVersion({
        runWrangler,
        workerName: 'my-worker',
        verifyUploader: () => true,
        preserveTriggers: true,
        expectedPreviousVersionId: CURRENT,
        message: encodeCloudflareVersionMessage([]),
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'inheritance-source-changed' });
    expect(runWrangler.mock.calls.some(([args]) => args[1] === 'deploy')).toBe(false);
  });

  it('can retry through a consecutive inactive version with a local verification receipt', async () => {
    let listed = 0;
    const failedCandidate = CONCURRENT;
    const base = runner();
    const runWrangler = vi.fn((args: Array<string>) => {
      if (args[0] === 'versions' && args[1] === 'list') {
        listed++;
        return ok(
          JSON.stringify(
            listed === 1
              ? [
                  { id: CURRENT, number: 1 },
                  { id: failedCandidate, number: 2 },
                ]
              : [
                  { id: CURRENT, number: 1 },
                  { id: failedCandidate, number: 2 },
                  { id: NEXT, number: 3 },
                ],
          ),
        );
      }
      return base(args);
    });
    await expect(
      activateCloudflareVersion({
        runWrangler,
        workerName: 'my-worker',
        verifyUploader: () => true,
        preserveTriggers: true,
        expectedPreviousVersionId: CURRENT,
        trustedInheritanceVersionIds: [failedCandidate],
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({ ok: true, versionId: NEXT });
  });

  it('snapshots and restores effective workers.dev and preview URL defaults', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'void-version-defaults-'));
    const configPath = join(directory, 'wrangler.json');
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          name: 'app',
          account_id: 'account',
          assets: { directory: '/already-removed/client' },
          main: '/already-removed/worker.js',
        }),
      );
      const triggerConfig = readCloudflareTriggerConfig(configPath);
      expect(triggerConfig.workers_dev).toBe(true);
      expect(triggerConfig.preview_urls).toBe(true);

      writeFileSync(
        configPath,
        JSON.stringify({
          name: 'app',
          account_id: 'account',
          assets: { directory: '/already-removed/client' },
          main: '/already-removed/worker.js',
          workers_dev: false,
          preview_urls: false,
        }),
      );
      let applied: Record<string, unknown> | undefined;
      await deployCloudflareVersionTriggers({
        runWrangler: async (args) => {
          const configIndex = args.indexOf('-c');
          applied = JSON.parse(readFileSync(args[configIndex + 1]!, 'utf-8')) as Record<
            string,
            unknown
          >;
          return ok();
        },
        workerName: 'app',
        configPath,
        triggerConfig,
      });
      expect(applied).not.toHaveProperty('workers_dev');
      expect(applied).not.toHaveProperty('preview_urls');
      expect(applied).not.toHaveProperty('routes');
      expect(applied).toMatchObject({ name: 'app', account_id: 'account' });
      expect(applied).not.toHaveProperty('assets');
      expect(applied).not.toHaveProperty('main');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not infer whole-trigger preservation for an ordinary empty config', () => {
    const directory = mkdtempSync(join(tmpdir(), 'void-version-empty-source-'));
    const generatedPath = join(directory, 'generated.json');
    const sourcePath = join(directory, 'wrangler.json');
    try {
      writeFileSync(generatedPath, JSON.stringify({ name: 'app', triggers: { crons: [] } }));
      writeFileSync(sourcePath, JSON.stringify({ name: 'app' }));
      expect(readCloudflareTriggerConfig(generatedPath, sourcePath)).toMatchObject({
        preserveRoutes: true,
        preserveWorkersDev: true,
        preservePreviewUrls: true,
        crons: [],
      });
      expect(readCloudflareTriggerConfig(generatedPath, sourcePath)).not.toHaveProperty('preserve');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails before upload when omitted existing visibility has no trusted snapshot', async () => {
    const runWrangler = runner({
      versions: ok(
        JSON.stringify([
          { id: CURRENT, annotations: { 'workers/message': encodeCloudflareVersionMessage([]) } },
        ]),
      ),
    });
    const desired = {
      preserveRoutes: true,
      preserveWorkersDev: true,
      preservePreviewUrls: true,
      workers_dev: true,
      preview_urls: true,
      routes: [],
      crons: ['0 * * * *'],
      queueConsumers: [],
      workflows: [],
    };
    await expect(
      activateCloudflareVersion({
        runWrangler,
        workerName: 'my-worker',
        verifyUploader: () => true,
        message: encodeCloudflareVersionMessage([], desired),
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'traffic-preservation-unavailable' });
    expect(runWrangler.mock.calls.some(([args]) => args[1] === 'upload')).toBe(false);
  });

  it('uses the last published traffic values while adding an ordinary cron', async () => {
    let applied: Record<string, unknown> | undefined;
    const base = runner();
    const runWrangler = vi.fn((args: Array<string>) => {
      if (args[0] === 'triggers') {
        applied = JSON.parse(readFileSync(args[args.indexOf('-c') + 1]!, 'utf8')) as Record<
          string,
          unknown
        >;
        return ok();
      }
      return base(args);
    });
    const desired = {
      preserveRoutes: true,
      preserveWorkersDev: true,
      preservePreviewUrls: true,
      workers_dev: true,
      preview_urls: true,
      routes: [],
      crons: ['0 * * * *'],
      queueConsumers: [],
      workflows: [],
    };
    await expect(
      activateCloudflareVersion({
        runWrangler,
        workerName: 'my-worker',
        verifyUploader: () => true,
        previousTrafficConfig: {
          workers_dev: false,
          preview_urls: true,
          routes: [{ pattern: 'app.example.com', custom_domain: true }],
        },
        message: encodeCloudflareVersionMessage([], desired),
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(applied).toMatchObject({
      workers_dev: false,
      preview_urls: true,
      routes: [{ pattern: 'app.example.com', custom_domain: true }],
      triggers: { crons: ['0 * * * *'] },
    });
  });

  it('continues an opaque handoff for a later code-only deployment', async () => {
    const preserved = {
      preserve: true,
      preserveRoutes: true,
      preserveWorkersDev: true,
      preservePreviewUrls: true,
      workers_dev: true,
      preview_urls: true,
      routes: [],
      crons: [],
      queueConsumers: [],
      workflows: [],
    };
    const runWrangler = runner({
      versions: ok(
        JSON.stringify([
          {
            id: CURRENT,
            annotations: { 'workers/message': encodeCloudflareVersionMessage([], preserved) },
          },
        ]),
      ),
    });
    await expect(
      activateCloudflareVersion({
        runWrangler,
        workerName: 'my-worker',
        configPath: '/app/wrangler.json',
        verifyUploader: () => true,
        message: encodeCloudflareVersionMessage([], { ...preserved, preserve: undefined }),
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({ ok: true, preservedTriggers: true });
    expect(runWrangler.mock.calls.some(([args]) => args[0] === 'triggers')).toBe(false);
  });

  it('continues an opaque handoff with unchanged explicit routes', async () => {
    const route = { pattern: 'app.example.com', custom_domain: true };
    const preserved = {
      preserve: true,
      preserveWorkersDev: true,
      preservePreviewUrls: true,
      workers_dev: false,
      preview_urls: false,
      routes: [route],
      crons: [],
      queueConsumers: [],
      workflows: [],
    };
    const runWrangler = runner({
      versions: ok(
        JSON.stringify([
          {
            id: CURRENT,
            annotations: { 'workers/message': encodeCloudflareVersionMessage([], preserved) },
          },
        ]),
      ),
    });
    const { preserve: _preserve, ...next } = preserved;
    await expect(
      activateCloudflareVersion({
        runWrangler,
        workerName: 'my-worker',
        configPath: '/app/wrangler.json',
        verifyUploader: () => true,
        message: encodeCloudflareVersionMessage([], next),
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({ ok: true, preservedTriggers: true });
    expect(runWrangler.mock.calls.some(([args]) => args[0] === 'triggers')).toBe(false);
  });

  it('does not silently suppress changed settings after an opaque handoff', async () => {
    const preserved = {
      preserve: true,
      preserveRoutes: true,
      preserveWorkersDev: true,
      preservePreviewUrls: true,
      settingsHash: 'before',
      workers_dev: true,
      preview_urls: true,
      routes: [],
      crons: [],
      queueConsumers: [],
      workflows: [],
    };
    const runWrangler = runner({
      versions: ok(
        JSON.stringify([
          {
            id: CURRENT,
            annotations: { 'workers/message': encodeCloudflareVersionMessage([], preserved) },
          },
        ]),
      ),
    });
    const { preserve: _preserve, ...next } = preserved;
    await expect(
      activateCloudflareVersion({
        runWrangler,
        workerName: 'my-worker',
        verifyUploader: () => true,
        message: encodeCloudflareVersionMessage([], { ...next, settingsHash: 'after' }),
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'traffic-preservation-unavailable' });
    expect(runWrangler.mock.calls.some(([args]) => args[1] === 'upload')).toBe(false);
  });

  it('preserves Wrangler route-aware traffic defaults', () => {
    const directory = mkdtempSync(join(tmpdir(), 'void-version-route-defaults-'));
    const configPath = join(directory, 'wrangler.json');
    try {
      writeFileSync(
        configPath,
        JSON.stringify({ name: 'app', routes: [{ pattern: 'app.example.com', zone_name: 'x' }] }),
      );
      expect(readCloudflareTriggerConfig(configPath)).toMatchObject({
        workers_dev: false,
        preview_urls: false,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('can reconcile non-route triggers without publishing a stale route snapshot', async () => {
    let applied: Record<string, unknown> | undefined;
    await deployCloudflareVersionTriggers({
      manageRoutes: false,
      runWrangler: async (args) => {
        const configIndex = args.indexOf('-c');
        applied = JSON.parse(readFileSync(args[configIndex + 1]!, 'utf-8')) as Record<
          string,
          unknown
        >;
        return ok();
      },
      workerName: 'app',
      triggerConfig: {
        workers_dev: false,
        preview_urls: false,
        routes: [{ pattern: 'apps.example.com/*', zone_name: 'example.com' }],
        crons: ['0 * * * *'],
        queueConsumers: [],
        workflows: [],
      },
    });

    expect(applied).not.toHaveProperty('routes');
    expect(applied).toMatchObject({ triggers: { crons: ['0 * * * *'] } });
  });

  it('removes queue consumers omitted from the desired trigger snapshot', async () => {
    const calls: Array<Array<string>> = [];
    const result = await deployCloudflareVersionTriggers({
      runWrangler: async (args) => {
        calls.push(args);
        return ok();
      },
      workerName: 'app',
      triggerConfig: {
        workers_dev: true,
        preview_urls: true,
        routes: [],
        crons: [],
        queueConsumers: [],
        workflows: [],
      },
      previousTriggerConfig: {
        workers_dev: true,
        preview_urls: true,
        routes: [],
        crons: [],
        queueConsumers: [{ queue: 'jobs' }],
        workflows: [],
      },
    });

    expect(result.status).toBe(0);
    expect(calls[1]).toEqual([
      'queues',
      'consumer',
      'remove',
      'jobs',
      'app',
      '-c',
      expect.any(String),
      '--env=',
    ]);
  });

  it('clears schedules without deleting removed workflow state', async () => {
    let applied: Record<string, unknown> | undefined;
    await deployCloudflareVersionTriggers({
      runWrangler: async (args) => {
        const configIndex = args.indexOf('-c');
        applied = JSON.parse(readFileSync(args[configIndex + 1]!, 'utf-8')) as Record<
          string,
          unknown
        >;
        return ok();
      },
      workerName: 'app',
      triggerConfig: {
        workers_dev: true,
        preview_urls: true,
        routes: [],
        crons: [],
        queueConsumers: [],
        workflows: [],
      },
      previousTriggerConfig: {
        workers_dev: true,
        preview_urls: true,
        routes: [],
        crons: [],
        queueConsumers: [],
        workflows: [{ name: 'nightly', class_name: 'NightlyWorkflow', schedules: ['0 0 * * *'] }],
      },
    });

    expect(applied?.workflows).toEqual([
      { name: 'nightly', class_name: 'NightlyWorkflow', schedules: [] },
    ]);
  });

  it('publishes an explicit empty set when removing the final custom domain', async () => {
    const publishEmptyCustomDomains = vi.fn(async () => ok());
    const result = await deployCloudflareVersionTriggers({
      runWrangler: async () => ok(),
      workerName: 'app',
      triggerConfig: {
        workers_dev: true,
        preview_urls: true,
        routes: [],
        crons: [],
        queueConsumers: [],
        workflows: [],
      },
      previousTriggerConfig: {
        workers_dev: false,
        preview_urls: false,
        routes: [{ pattern: 'app.example.com', custom_domain: true }],
        crons: [],
        queueConsumers: [],
        workflows: [],
      },
      publishEmptyCustomDomains,
    });

    expect(result.status).toBe(0);
    expect(publishEmptyCustomDomains).toHaveBeenCalledOnce();
  });

  it('normalizes and extracts workers.dev account subdomains', () => {
    expect(normalizeWorkersDevSubdomain('Developer-Platform-Experience.workers.dev/')).toBe(
      'developer-platform-experience',
    );
    expect(normalizeWorkersDevSubdomain('not valid')).toBeUndefined();
    expect(normalizeWorkersDevSubdomain('My-Team.fed.workers.dev')).toBe('my-team.fed');
    expect(
      extractWorkersDevSubdomain(
        'https://void-ready-abc-my-worker.developer-platform-experience.workers.dev/path',
      ),
    ).toBe('developer-platform-experience');
    expect(
      extractWorkersDevSubdomain('https://void-ready-abc-my-worker.my-team.fed.workers.dev/path'),
    ).toBe('my-team.fed');
    expect(extractWorkersDevSubdomain('https://example.com')).toBeUndefined();
    expect(extractWorkersDevSubdomain('https://worker.my-team.other.workers.dev')).toBeUndefined();
  });

  it('round-trips migration metadata and rejects unrelated annotations', () => {
    const message = encodeCloudflareVersionMessage(['0001_init.sql', '0002_users.sql']);
    expect(parseCloudflareVersionMessage(message)).toEqual({
      schema: 1,
      migrations: ['0001_init.sql', '0002_users.sql'],
    });
    expect(parseCloudflareVersionMessage('manual deploy')).toBeNull();
    expect(parseCloudflareVersionMessage('void:{bad')).toBeNull();
  });

  // Wrangler 4.131 applies its Email Routing plan inside `triggers deploy`, reading the
  // config's `addresses`. The trigger-only config Void hands it must therefore carry the
  // snapshot's addresses verbatim — and carry NOTHING when the snapshot has none, because an
  // absent key skips the plan while `[]` deletes every rule the Worker owns.
  it('carries Email Routing addresses through the trigger snapshot and the trigger config', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'void-version-addresses-'));
    const configPath = join(directory, 'wrangler.json');
    const applied = async (
      triggerConfig: Parameters<typeof deployCloudflareVersionTriggers>[0]['triggerConfig'],
    ): Promise<Record<string, unknown>> => {
      let config: Record<string, unknown> | undefined;
      await deployCloudflareVersionTriggers({
        runWrangler: async (args) => {
          const configIndex = args.indexOf('-c');
          config = JSON.parse(readFileSync(args[configIndex + 1]!, 'utf-8')) as Record<
            string,
            unknown
          >;
          return ok();
        },
        workerName: 'app',
        configPath,
        triggerConfig,
      });
      return config!;
    };
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          name: 'app',
          account_id: 'account',
          send_email: [{ name: 'SEND_EMAIL' }],
          addresses: ['support@mail.acme.com', 'billing@mail.acme.com'],
        }),
      );
      const withAddresses = readCloudflareTriggerConfig(configPath);
      expect(withAddresses.addresses).toEqual(['support@mail.acme.com', 'billing@mail.acme.com']);
      expect(await applied(withAddresses)).toMatchObject({
        addresses: ['support@mail.acme.com', 'billing@mail.acme.com'],
      });
      // The annotation round-trips the addresses, so a rollback restores that version's rules.
      expect(
        parseCloudflareVersionMessage(encodeCloudflareVersionMessage([], withAddresses)),
      ).toEqual({ schema: 2, migrations: [], triggerConfig: withAddresses });

      // An explicit empty array is a destructive plan and must survive as `[]`, not vanish.
      writeFileSync(configPath, JSON.stringify({ name: 'app', addresses: [] }));
      const emptied = readCloudflareTriggerConfig(configPath);
      expect(emptied.addresses).toEqual([]);
      expect(await applied(emptied)).toMatchObject({ addresses: [] });

      // No `addresses` at all — the key must not reach Wrangler, or it would plan on it.
      writeFileSync(configPath, JSON.stringify({ name: 'app', account_id: 'account' }));
      const without = readCloudflareTriggerConfig(configPath);
      expect(without).not.toHaveProperty('addresses');
      expect(await applied(without)).not.toHaveProperty('addresses');
      // A rollback replays the TARGET snapshot only: the version being left never lends its
      // addresses to the trigger config, so a rollback from an email-enabled version to one
      // recorded without `addresses` skips the plan and leaves the rules where they are —
      // routed to a Worker that no longer exports `email()`. That is the one shape both an
      // absent key and a pre-`addresses` (legacy) snapshot share, and it is not `[]`: a
      // snapshot carrying `[]` would make every rollback to it a destructive plan (wrangler's
      // default-No y/n in a TTY, a UserError in CI), which `stabilizeCloudflareVersionTriggers`
      // reports as `triggers-failed` and the caller compensates by restoring the version it
      // just left. Encoding "handlers removed" as `[]` is therefore a product call, not a fix.
      let rollbackConfig: Record<string, unknown> | undefined;
      await deployCloudflareVersionTriggers({
        runWrangler: async (args) => {
          const configIndex = args.indexOf('-c');
          rollbackConfig = JSON.parse(readFileSync(args[configIndex + 1]!, 'utf-8')) as Record<
            string,
            unknown
          >;
          return ok();
        },
        workerName: 'app',
        configPath,
        triggerConfig: without,
        previousTriggerConfig: withAddresses,
      });
      expect(rollbackConfig).not.toHaveProperty('addresses');
      // A malformed array is not an address list; treat it as absent rather than planning on it.
      writeFileSync(configPath, JSON.stringify({ name: 'app', addresses: [{ bad: true }] }));
      expect(readCloudflareTriggerConfig(configPath)).not.toHaveProperty('addresses');
      expect(
        parseCloudflareVersionMessage(
          `void:${JSON.stringify({ schema: 2, migrations: [], triggerConfig: { ...without, addresses: 'support@mail.acme.com' } })}`,
        ),
      ).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uploads, probes, activates, and applies triggers in order', async () => {
    const runWrangler = runner();
    const fetcher = vi.fn(async () => Response.json({ ready: true }));
    const result = await activateCloudflareVersion({
      runWrangler,
      verifyUploader: () => true,
      workerName: 'my-worker',
      configPath: '/app/wrangler.jsonc',
      assetsDirectoryOverride: '/app/.void/deploy/cloudflare/assets',
      message: encodeCloudflareVersionMessage(['0001_init.sql']),
      fetch: fetcher,
      sleep: async () => {},
    });

    expect(result).toEqual({
      ok: true,
      versionId: NEXT,
      previewUrl: 'https://my-worker.example.workers.dev',
      previousVersionId: CURRENT,
      trafficConfig: {
        workers_dev: true,
        preview_urls: true,
        routes: [],
      },
      workersDevSubdomain: 'example',
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://ready.example.workers.dev/__void/ready',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(runWrangler.mock.calls.map(([args]) => args.slice(0, 2))).toEqual([
      ['deployments', 'status'],
      ['versions', 'upload'],
      ['deployments', 'status'],
      ['versions', 'deploy'],
      ['deployments', 'status'],
      ['triggers', 'deploy'],
      ['deployments', 'status'],
    ]);
    expect(runWrangler.mock.calls[1]![0]).toContain('--strict');
    expect(runWrangler.mock.calls[1]![0]).toContain('--assets');
    expect(runWrangler.mock.calls[1]![0]).toContain('/app/.void/deploy/cloudflare/assets');
    expect(runWrangler.mock.calls[3]![0]).toContain(`${NEXT}@100`);
    expect(runWrangler.mock.calls[5]![0]).toEqual([
      'triggers',
      'deploy',
      '-c',
      expect.stringContaining('void-version-triggers-'),
      '--env=',
      '--name',
      'my-worker',
    ]);
  });

  it('repairs triggers for a rollback that wins while deployment activation is in flight', async () => {
    const activation = deferred<CloudflareCommandResult>();
    const activationStarted = deferred<void>();
    let activeVersionId = CURRENT;
    let appliedTriggerConfig: Record<string, unknown> | undefined;
    const concurrentTriggerConfig = {
      workers_dev: true,
      preview_urls: true,
      routes: [],
      crons: ['concurrent'],
      queueConsumers: [{ queue: 'concurrent-jobs' }],
      workflows: [],
    };
    const runWrangler = vi.fn(async (args: Array<string>) => {
      if (args[0] === 'deployments') {
        return ok(JSON.stringify({ versions: [{ version_id: activeVersionId, percentage: 100 }] }));
      }
      if (args[0] === 'versions' && args[1] === 'upload') {
        return ok(
          `Worker Version ID: ${NEXT}\nVersion Preview URL: https://ready.example.workers.dev`,
        );
      }
      if (args[0] === 'versions' && args[1] === 'deploy') {
        activeVersionId = NEXT;
        activationStarted.resolve(undefined);
        return activation.promise;
      }
      if (args[0] === 'versions' && args[1] === 'list') {
        return ok(
          JSON.stringify([
            {
              id: CONCURRENT,
              annotations: {
                'workers/message': encodeCloudflareVersionMessage([], concurrentTriggerConfig),
              },
            },
          ]),
        );
      }
      if (args[0] === 'triggers') {
        const configIndex = args.indexOf('-c');
        appliedTriggerConfig = JSON.parse(readFileSync(args[configIndex + 1]!, 'utf8')) as Record<
          string,
          unknown
        >;
        return ok();
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const pending = activateCloudflareVersion({
      runWrangler,
      verifyUploader: () => true,
      workerName: 'my-worker',
      message: encodeCloudflareVersionMessage([], {
        workers_dev: true,
        preview_urls: true,
        routes: [],
        crons: ['deploy'],
        queueConsumers: [],
        workflows: [],
      }),
      fetch: async () => Response.json({ ready: true }),
    });
    await activationStarted.promise;
    activeVersionId = CONCURRENT;
    activation.resolve(ok());

    await expect(pending).resolves.toMatchObject({
      ok: false,
      reason: 'deployment-changed',
      activeVersionId: CONCURRENT,
      triggerRepair: 'succeeded',
    });
    expect(appliedTriggerConfig).toMatchObject({
      triggers: { crons: ['concurrent'] },
      queues: { consumers: [{ queue: 'concurrent-jobs' }] },
    });
  });

  it('removes explicitly owned legacy consumers when the previous metadata is schema 1', async () => {
    const runWrangler = runner({
      versions: ok(
        JSON.stringify([
          {
            id: CURRENT,
            annotations: { 'workers/message': encodeCloudflareVersionMessage([]) },
          },
        ]),
      ),
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        message: encodeCloudflareVersionMessage([], {
          workers_dev: true,
          preview_urls: true,
          routes: [],
          crons: [],
          queueConsumers: [],
          workflows: [],
        }),
        queueConsumerCleanup: ['legacy-jobs'],
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(
      runWrangler.mock.calls.find(
        ([args]) => args[0] === 'queues' && args[1] === 'consumer' && args[2] === 'remove',
      )?.[0],
    ).toEqual([
      'queues',
      'consumer',
      'remove',
      'legacy-jobs',
      'my-worker',
      '-c',
      expect.any(String),
      '--env=',
    ]);
  });

  it('replays the previous snapshot addresses when managed-queue cleanup rebuilds it', async () => {
    // `queueConsumerCleanup` is non-empty on EVERY deploy of a project with Void-managed
    // consumers (`readWranglerManagedQueueCleanupCandidates` includes the current consumers
    // for schema-1 upgrades), so the rebuilt previous config is what `stabilize…` replays when
    // a concurrent rollback returns traffic to the previous version. Wrangler's Email Routing
    // plan takes no "previous" list — it reconciles to exactly the replayed `addresses`, and
    // skips the plan when the key is absent — so the copy must keep that version's own value:
    // absent, `[]`, and a list are three different plans.
    const replayed = async (
      previousAddresses: ReadonlyArray<string> | undefined,
    ): Promise<Record<string, unknown>> => {
      const activation = deferred<CloudflareCommandResult>();
      const activationStarted = deferred<void>();
      let activeVersionId = CURRENT;
      let appliedTriggerConfig: Record<string, unknown> | undefined;
      const previousTriggerConfig = {
        workers_dev: true,
        preview_urls: true,
        routes: [],
        crons: [],
        queueConsumers: [],
        workflows: [],
        ...(previousAddresses === undefined ? {} : { addresses: previousAddresses }),
      };
      const runWrangler = async (args: Array<string>) => {
        if (args[0] === 'deployments') {
          return ok(
            JSON.stringify({ versions: [{ version_id: activeVersionId, percentage: 100 }] }),
          );
        }
        if (args[0] === 'versions' && args[1] === 'upload') {
          return ok(
            `Worker Version ID: ${NEXT}\nVersion Preview URL: https://ready.example.workers.dev`,
          );
        }
        if (args[0] === 'versions' && args[1] === 'deploy') {
          activeVersionId = NEXT;
          activationStarted.resolve(undefined);
          return activation.promise;
        }
        if (args[0] === 'versions' && args[1] === 'list') {
          return ok(
            JSON.stringify([
              {
                id: CURRENT,
                annotations: {
                  'workers/message': encodeCloudflareVersionMessage([], previousTriggerConfig),
                },
              },
            ]),
          );
        }
        if (args[0] === 'triggers') {
          const configIndex = args.indexOf('-c');
          appliedTriggerConfig = JSON.parse(readFileSync(args[configIndex + 1]!, 'utf8')) as Record<
            string,
            unknown
          >;
          return ok();
        }
        if (args[0] === 'queues') {
          return ok();
        }
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      };

      const pending = activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        message: encodeCloudflareVersionMessage([], {
          workers_dev: true,
          preview_urls: true,
          routes: [],
          crons: [],
          queueConsumers: [],
          workflows: [],
          addresses: ['billing@mail.acme.com'],
        }),
        queueConsumerCleanup: ['jobs'],
        fetch: async () => Response.json({ ready: true }),
      });
      await activationStarted.promise;
      // A concurrent rollback to the previous version wins before triggers are published.
      activeVersionId = CURRENT;
      activation.resolve(ok());

      await expect(pending).resolves.toMatchObject({
        ok: false,
        reason: 'deployment-changed',
        activeVersionId: CURRENT,
        triggerRepair: 'succeeded',
      });
      return appliedTriggerConfig!;
    };

    expect(await replayed(['support@mail.acme.com'])).toMatchObject({
      addresses: ['support@mail.acme.com'],
      queues: { consumers: [{ queue: 'jobs' }] },
    });
    expect(await replayed([])).toMatchObject({ addresses: [] });
    expect(await replayed(undefined)).not.toHaveProperty('addresses');
  });

  it('does not compensate over a concurrent owner after trigger failure', async () => {
    const failedTriggers = deferred<CloudflareCommandResult>();
    const triggerStarted = deferred<void>();
    let activeVersionId = CURRENT;
    let triggerCalls = 0;
    let repairedConfig: Record<string, unknown> | undefined;
    const configFor = (cron: string) => ({
      workers_dev: true,
      preview_urls: true,
      routes: [],
      crons: [cron],
      queueConsumers: [],
      workflows: [],
    });
    const runWrangler = vi.fn(async (args: Array<string>) => {
      if (args[0] === 'deployments') {
        return ok(JSON.stringify({ versions: [{ version_id: activeVersionId, percentage: 100 }] }));
      }
      if (args[0] === 'versions' && args[1] === 'upload') {
        return ok(
          `Worker Version ID: ${NEXT}\nVersion Preview URL: https://ready.example.workers.dev`,
        );
      }
      if (args[0] === 'versions' && args[1] === 'deploy') {
        activeVersionId = NEXT;
        return ok();
      }
      if (args[0] === 'versions' && args[1] === 'list') {
        return ok(
          JSON.stringify(
            [
              [CURRENT, configFor('current')],
              [CONCURRENT, configFor('concurrent')],
            ].map(([id, triggerConfig]) => ({
              id,
              annotations: {
                'workers/message': encodeCloudflareVersionMessage(
                  [],
                  triggerConfig as ReturnType<typeof configFor>,
                ),
              },
            })),
          ),
        );
      }
      if (args[0] === 'triggers') {
        triggerCalls++;
        if (triggerCalls === 1) {
          triggerStarted.resolve(undefined);
          return failedTriggers.promise;
        }
        const configIndex = args.indexOf('-c');
        repairedConfig = JSON.parse(readFileSync(args[configIndex + 1]!, 'utf8')) as Record<
          string,
          unknown
        >;
        return ok();
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const pending = activateCloudflareVersion({
      runWrangler,
      verifyUploader: () => true,
      workerName: 'my-worker',
      message: encodeCloudflareVersionMessage([], configFor('next')),
      fetch: async () => Response.json({ ready: true }),
    });
    await triggerStarted.promise;
    activeVersionId = CONCURRENT;
    failedTriggers.resolve({ ...ok(), status: 1 });

    await expect(pending).resolves.toMatchObject({
      ok: false,
      reason: 'deployment-changed',
      activeVersionId: CONCURRENT,
      rollback: 'not-needed',
      triggerRepair: 'succeeded',
    });
    expect(repairedConfig).toMatchObject({ triggers: { crons: ['concurrent'] } });
    expect(
      runWrangler.mock.calls.filter(([args]) => args[0] === 'versions' && args[1] === 'deploy'),
    ).toHaveLength(1);
  });

  it('uses newer published traffic provenance instead of a stale version annotation', async () => {
    const staleTriggerConfig = {
      workers_dev: false,
      preview_urls: false,
      routes: [{ pattern: 'old.example.com', custom_domain: true }],
      crons: [],
      queueConsumers: [],
      workflows: [],
    };
    const desiredTriggerConfig = {
      ...staleTriggerConfig,
      workers_dev: true,
      preview_urls: true,
      routes: [],
    };
    const runWrangler = runner({
      versions: ok(
        JSON.stringify([
          {
            id: CURRENT,
            annotations: {
              'workers/message': encodeCloudflareVersionMessage([], staleTriggerConfig),
            },
          },
        ]),
      ),
    });
    const publishEmptyCustomDomains = vi.fn(async () => ok());

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        message: encodeCloudflareVersionMessage([], desiredTriggerConfig),
        previousTrafficConfig: {
          workers_dev: true,
          preview_urls: true,
          routes: [],
        },
        publishEmptyCustomDomains,
        fetch: async () => Response.json({ ready: true }),
        sleep: async () => {},
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(publishEmptyCustomDomains).not.toHaveBeenCalled();
  });

  it('does not activate a version whose preview never becomes ready', async () => {
    const runWrangler = runner();
    const result = await activateCloudflareVersion({
      runWrangler,
      verifyUploader: () => true,
      workerName: 'my-worker',
      message: encodeCloudflareVersionMessage([]),
      fetch: async () => new Response('not ready', { status: 503 }),
      sleep: async () => {},
      readinessAttempts: 2,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'readiness-failed',
      versionId: NEXT,
      rollback: 'not-needed',
    });
    expect(runWrangler.mock.calls.some(([args]) => args[1] === 'deploy')).toBe(false);
  });

  it('sends Access service-token headers only to the matching Workers preview host', async () => {
    const runWrangler = runner({
      upload: ok(
        `Worker Version ID: ${NEXT}\nVersion Preview Alias URL: https://void-ready-abc-my-worker.developer-platform-experience.workers.dev`,
      ),
    });
    const fetcher = vi.fn(async () => Response.json({ ready: true }));

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        workersDevSubdomain: 'attacker-account',
        message: encodeCloudflareVersionMessage([]),
        readinessHeaders: {
          'CF-Access-Client-Id': 'service-id',
          'CF-Access-Client-Secret': 'service-secret',
        },
        fetch: fetcher,
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(fetcher).toHaveBeenCalledWith(
      'https://void-ready-abc-my-worker.developer-platform-experience.workers.dev/__void/ready',
      expect.objectContaining({
        headers: expect.objectContaining({
          'CF-Access-Client-Id': 'service-id',
          'CF-Access-Client-Secret': 'service-secret',
        }),
        redirect: 'manual',
      }),
    );
  });

  it('never forwards Access service-token headers to an unrelated readiness host', async () => {
    const runWrangler = runner({
      upload: ok(`Worker Version ID: ${NEXT}\nVersion Preview Alias URL: https://attacker.example`),
    });
    const fetcher = vi.fn(async () => Response.json({ ready: true }));

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        message: encodeCloudflareVersionMessage([]),
        readinessHeaders: {
          'CF-Access-Client-Id': 'service-id',
          'CF-Access-Client-Secret': 'service-secret',
        },
        fetch: fetcher,
        sleep: async () => {},
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'readiness-failed' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('falls back from an Access-blocked preview alias to the stable Worker hostname', async () => {
    const runWrangler = runner({
      upload: ok(
        `Worker Version ID: ${NEXT}\nVersion Preview Alias URL: https://void-ready-abc-my-worker.developer-platform-experience.workers.dev`,
      ),
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('error code: 1050', { status: 403 }))
      .mockResolvedValueOnce(Response.json({ ready: true }));

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        message: encodeCloudflareVersionMessage([]),
        fetch: fetcher,
        sleep: async () => {},
      }),
    ).resolves.toMatchObject({
      ok: true,
      versionId: NEXT,
      previewUrl: 'https://my-worker.developer-platform-experience.workers.dev',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith(
      'https://my-worker.developer-platform-experience.workers.dev/__void/ready',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Cloudflare-Workers-Version-Overrides': `my-worker="${NEXT}"`,
        }),
      }),
    );
    expect(runWrangler.mock.calls[2]![0]).toEqual(
      expect.arrayContaining([`${CURRENT}@100`, `${NEXT}@0`]),
    );
    expect(runWrangler.mock.calls[4]![0]).toContain(`${NEXT}@100`);
  });

  it('never sends Access headers to an unverified cached workers.dev subdomain', async () => {
    const runWrangler = runner({ upload: ok(`Worker Version ID: ${NEXT}`) });
    const fetcher = vi.fn(async () => Response.json({ ready: true }));

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        workersDevSubdomain: 'stale-or-attacker',
        message: encodeCloudflareVersionMessage([]),
        readinessHeaders: { 'CF-Access-Token': 'secret' },
        fetch: fetcher,
        readinessAttempts: 1,
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'readiness-failed' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends Access headers to an explicitly trusted workers.dev fallback', async () => {
    const runWrangler = runner({ upload: ok(`Worker Version ID: ${NEXT}`) });
    const fetcher = vi.fn(async () => Response.json({ ready: true }));

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        workersDevSubdomain: 'developer-platform-experience',
        readinessHeadersWorkersDevSubdomain: 'developer-platform-experience',
        message: encodeCloudflareVersionMessage([]),
        readinessHeaders: { 'cf-access-token': 'short-lived-user-jwt' },
        fetch: fetcher,
      }),
    ).resolves.toMatchObject({ ok: true, versionId: NEXT });
    expect(fetcher).toHaveBeenCalledWith(
      'https://my-worker.developer-platform-experience.workers.dev/__void/ready',
      expect.objectContaining({
        headers: expect.objectContaining({
          'cf-access-token': 'short-lived-user-jwt',
          'Cloudflare-Workers-Version-Overrides': `my-worker="${NEXT}"`,
        }),
      }),
    );
  });

  it('restores the prior deployment when Access blocks both readiness hostnames', async () => {
    const runWrangler = runner({
      upload: ok(
        `Worker Version ID: ${NEXT}\nVersion Preview Alias URL: https://void-ready-abc-my-worker.developer-platform-experience.workers.dev`,
      ),
    });
    const fetcher = vi.fn(async () => new Response('error code: 1050', { status: 403 }));

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        message: encodeCloudflareVersionMessage([]),
        fetch: fetcher,
        sleep: async () => {},
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'readiness-access-denied',
      rollback: 'succeeded',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(runWrangler.mock.calls[2]![0]).toEqual(
      expect.arrayContaining([`${CURRENT}@100`, `${NEXT}@0`]),
    );
    expect(runWrangler.mock.calls[3]![0]).toContain(`${CURRENT}@100`);
    expect(runWrangler.mock.calls.some(([args]) => args[0] === 'triggers')).toBe(false);
  });

  it('leaves a first uploaded version inactive when its preview alias is Access-blocked', async () => {
    const runWrangler = runner({
      status: { stdout: '', stderr: 'The Worker first has no deployments.', status: 1 },
      upload: ok(
        `Worker Version ID: ${NEXT}\nVersion Preview Alias URL: https://void-ready-abc-first.developer-platform-experience.workers.dev`,
      ),
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'first',
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => new Response('error code: 1050', { status: 403 }),
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'readiness-access-denied',
      rollback: 'not-needed',
    });
    expect(runWrangler.mock.calls.some(([args]) => args[1] === 'deploy')).toBe(false);
  });

  it('refuses to flatten an existing gradual traffic split', async () => {
    const runWrangler = runner({
      status: ok(
        JSON.stringify({
          versions: [
            { version_id: CURRENT, percentage: 90 },
            { version_id: NEXT, percentage: 10 },
          ],
        }),
      ),
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        message: encodeCloudflareVersionMessage([]),
      }),
    ).resolves.toEqual({ ok: false, reason: 'traffic-split-unsupported' });
    expect(runWrangler).toHaveBeenCalledTimes(1);
  });

  it('verifies the uploader before reading credentialed deployment status', async () => {
    const runWrangler = runner();

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => false,
        workerName: 'my-worker',
        message: encodeCloudflareVersionMessage([]),
      }),
    ).resolves.toEqual({ ok: false, reason: 'uploader-changed' });
    expect(runWrangler).not.toHaveBeenCalled();
  });

  it('fails closed when Wrangler does not return a preview URL', async () => {
    const runWrangler = runner({ upload: ok(`Worker Version ID: ${NEXT}`) });
    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        message: encodeCloudflareVersionMessage([]),
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'preview-unavailable', versionId: NEXT });
  });

  it('probes a zero-percent Durable Object version through a production workers.dev URL', async () => {
    const runWrangler = runner({ upload: ok(`Worker Version ID: ${NEXT}`) });
    const fetcher = vi.fn(async () => Response.json({ ready: true }));

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        workersDevSubdomain: 'developer-platform-experience',
        message: encodeCloudflareVersionMessage([]),
        fetch: fetcher,
      }),
    ).resolves.toMatchObject({
      ok: true,
      versionId: NEXT,
      previewUrl: 'https://my-worker.developer-platform-experience.workers.dev',
    });

    expect(runWrangler.mock.calls.map(([args]) => args.slice(0, 2))).toEqual([
      ['deployments', 'status'],
      ['versions', 'upload'],
      ['versions', 'deploy'],
      ['deployments', 'status'],
      ['versions', 'deploy'],
      ['deployments', 'status'],
      ['triggers', 'deploy'],
      ['deployments', 'status'],
    ]);
    expect(runWrangler.mock.calls[2]![0]).toEqual(
      expect.arrayContaining([`${CURRENT}@100`, `${NEXT}@0`]),
    );
    expect(runWrangler.mock.calls[4]![0]).toContain(`${NEXT}@100`);
    expect(fetcher).toHaveBeenCalledWith(
      'https://my-worker.developer-platform-experience.workers.dev/__void/ready',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Cloudflare-Workers-Version-Overrides': `my-worker="${NEXT}"`,
        }),
      }),
    );
  });

  it('restores the prior deployment when a zero-percent version is not ready', async () => {
    const runWrangler = runner({ upload: ok(`Worker Version ID: ${NEXT}`) });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        workersDevSubdomain: 'developer-platform-experience',
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => new Response('not ready', { status: 503 }),
        sleep: async () => {},
        readinessAttempts: 1,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'readiness-failed',
      rollback: 'succeeded',
    });

    expect(runWrangler.mock.calls[2]![0]).toEqual(
      expect.arrayContaining([`${CURRENT}@100`, `${NEXT}@0`]),
    );
    expect(runWrangler.mock.calls[3]![0]).toContain(`${CURRENT}@100`);
    expect(runWrangler.mock.calls.some(([args]) => args[0] === 'triggers')).toBe(false);
  });

  it('does not invoke a changed uploader to restore zero-percent staging', async () => {
    const runWrangler = runner({ upload: ok(`Worker Version ID: ${NEXT}`) });
    let verification = 0;

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => ++verification < 4,
        workerName: 'my-worker',
        workersDevSubdomain: 'developer-platform-experience',
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => new Response('not ready', { status: 503 }),
        sleep: async () => {},
        readinessAttempts: 1,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'readiness-failed',
      rollback: 'unsafe',
    });

    expect(runWrangler.mock.calls.map(([args]) => args[0])).toEqual([
      'deployments',
      'versions',
      'versions',
    ]);
  });

  it('bootstraps a proven first deploy when account preview URLs are disabled', async () => {
    const runWrangler = runner({
      upload: ok(`Worker Version ID: ${NEXT}`),
      bootstrap: ok(`Current Version ID: ${NEXT}\nhttps://first.example.workers.dev`),
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'first-with-secret',
        message: encodeCloudflareVersionMessage([]),
        allowFirstDeploymentBootstrap: true,
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({
      ok: true,
      previewUrl: 'https://first-with-secret.example.workers.dev',
    });
    expect(runWrangler.mock.calls.map(([args]) => args[0])).toEqual([
      'deployments',
      'versions',
      'deploy',
    ]);
  });

  it('rolls traffic back when trigger activation fails', async () => {
    const runWrangler = runner({ triggers: { ...ok(), status: 1 } });
    const result = await activateCloudflareVersion({
      runWrangler,
      verifyUploader: () => true,
      workerName: 'my-worker',
      message: encodeCloudflareVersionMessage([]),
      fetch: async () => Response.json({ ready: true }),
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'triggers-failed',
      rollback: 'succeeded',
      previousVersionId: CURRENT,
    });
    expect(
      runWrangler.mock.calls.some(([args]) =>
        args.some((argument) => argument === `${CURRENT}@100`),
      ),
    ).toBe(true);
    expect(runWrangler.mock.calls.filter(([args]) => args[0] === 'triggers')).toHaveLength(2);
  });

  it('does not claim trigger rollback succeeded without prior trigger metadata', async () => {
    const runWrangler = runner({
      triggers: { ...ok(), status: 1 },
      versions: ok(
        JSON.stringify([
          {
            id: CURRENT,
            annotations: { 'workers/message': encodeCloudflareVersionMessage([]) },
          },
        ]),
      ),
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'triggers-failed',
      rollback: 'unavailable',
    });
    expect(runWrangler.mock.calls.filter(([args]) => args[0] === 'triggers')).toHaveLength(1);
  });

  it('does not invoke a changed uploader to roll traffic back after activation', async () => {
    const runWrangler = runner();
    let verification = 0;
    const result = await activateCloudflareVersion({
      runWrangler,
      verifyUploader: () => ++verification < 4,
      workerName: 'my-worker',
      message: encodeCloudflareVersionMessage([]),
      fetch: async () => Response.json({ ready: true }),
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'uploader-changed',
      rollback: 'unsafe',
      previousVersionId: CURRENT,
    });
    expect(runWrangler.mock.calls.at(-1)![0]).toContain(`${NEXT}@100`);
    expect(runWrangler.mock.calls.some(([args]) => args[0] === 'triggers')).toBe(false);
  });

  it('accepts the first deployment when status reports no deployments', async () => {
    const runWrangler = runner({
      status: { stdout: '', stderr: 'The Worker first has no deployments.', status: 1 },
    });
    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'first',
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({ ok: true, previousVersionId: null });
  });

  it('accepts Wrangler error 10007 as a Worker that has not been created yet', async () => {
    const runWrangler = runner({
      status: {
        stdout: '',
        stderr: 'This Worker does not exist on your account. [code: 10007]',
        status: 1,
      },
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'first',
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({ ok: true, previousVersionId: null });
  });

  it('probes a custom route when workers.dev and preview URLs are disabled', async () => {
    const runWrangler = runner({
      upload: ok(`Worker Version ID: ${NEXT}`),
    });
    const fetcher = vi.fn(async () => Response.json({ ready: true }));
    const triggerConfig = {
      workers_dev: false,
      preview_urls: false,
      routes: [{ pattern: 'app.example.com/*', zone_name: 'example.com' }],
      crons: [],
      queueConsumers: [],
      workflows: [],
    };

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'private-app',
        workersDevSubdomain: 'account',
        readinessHeaders: { 'CF-Access-Client-Secret': 'must-not-leak' },
        message: encodeCloudflareVersionMessage([], triggerConfig),
        fetch: fetcher,
      }),
    ).resolves.toMatchObject({ ok: true, previewUrl: 'https://app.example.com' });
    expect(fetcher).toHaveBeenCalledWith(
      'https://app.example.com/__void/ready',
      expect.objectContaining({
        headers: {
          'user-agent': 'void-deploy-readiness/1',
          'Cloudflare-Workers-Version-Overrides': `private-app="${NEXT}"`,
        },
      }),
    );
  });

  it('probes a custom route after first-deployment bootstrap', async () => {
    const triggerConfig = {
      workers_dev: false,
      preview_urls: false,
      routes: [{ pattern: 'bootstrap.example.com', custom_domain: true }],
      crons: [],
      queueConsumers: [],
      workflows: [],
    };
    const runWrangler = runner({
      status: { stdout: '', stderr: 'This Worker does not exist. [code: 10007]', status: 1 },
      upload: {
        stdout: '',
        stderr: 'Durable Object migrations require deploy. [code: 10211]',
        status: 1,
      },
      bootstrap: ok(`Current Version ID: ${NEXT}`),
    });
    const fetcher = vi.fn(async () => Response.json({ ready: true }));

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'bootstrap-private',
        message: encodeCloudflareVersionMessage([], triggerConfig),
        fetch: fetcher,
      }),
    ).resolves.toMatchObject({
      ok: true,
      previewUrl: 'https://bootstrap.example.com',
      previousVersionId: null,
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://bootstrap.example.com/__void/ready',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('bootstraps first-deploy Durable Object migrations through a non-versioned deploy', async () => {
    const runWrangler = runner({
      status: { stdout: '', stderr: 'The Worker first has no deployments.', status: 1 },
      upload: {
        stdout: '',
        stderr: 'Durable Object migrations require deploy. [code: 10211]',
        status: 1,
      },
      bootstrap: ok(
        `Current Version ID: ${NEXT}\nVersion Preview URL: https://2e209d56-first.example.workers.dev`,
      ),
    });
    const fetcher = vi.fn(async () => Response.json({ ready: true }));

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'first',
        configPath: '/app/wrangler.jsonc',
        assetsDirectoryOverride: '/app/.void/deploy/cloudflare/assets',
        message: encodeCloudflareVersionMessage(['0001_init.sql']),
        fetch: fetcher,
      }),
    ).resolves.toEqual({
      ok: true,
      versionId: NEXT,
      previewUrl: 'https://first.example.workers.dev',
      previousVersionId: null,
      workersDevSubdomain: 'example',
    });
    expect(runWrangler.mock.calls.map(([args]) => args.slice(0, 2))).toEqual([
      ['deployments', 'status'],
      ['versions', 'upload'],
      ['deploy', '-c'],
    ]);
    expect(runWrangler.mock.calls[2]![0]).toContain('--autoconfig=false');
    expect(runWrangler.mock.calls[2]![0]).toContain('--assets');
    expect(runWrangler.mock.calls[2]![0]).toContain('/app/.void/deploy/cloudflare/assets');
    expect(fetcher).toHaveBeenCalledWith(
      'https://first.example.workers.dev/__void/ready',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('reports Access blocking the already-active first Worker bootstrap', async () => {
    const runWrangler = runner({
      status: { stdout: '', stderr: 'The Worker first has no deployments.', status: 1 },
      upload: {
        stdout: '',
        stderr: 'Durable Object migrations require deploy. [code: 10211]',
        status: 1,
      },
      bootstrap: ok(`Current Version ID: ${NEXT}\nhttps://first.example.workers.dev`),
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'first',
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => new Response('error code: 1050', { status: 403 }),
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'bootstrap-readiness-access-denied',
      rollback: 'unavailable',
    });
  });

  it('bootstraps a Worker that the Versions API cannot create', async () => {
    const runWrangler = runner({
      status: { stdout: '', stderr: 'This Worker does not exist. [code: 10007]', status: 1 },
      upload: {
        stdout: '',
        stderr:
          'You cannot upload a new version of a Worker that does not yet exist. Please run the `deploy` command first.',
        status: 1,
      },
      bootstrap: ok(`Current Version ID: ${NEXT}\nhttps://first.example.workers.dev`),
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'first-static',
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({ ok: true, previousVersionId: null });
    expect(runWrangler.mock.calls.map(([args]) => args[0])).toEqual([
      'deployments',
      'versions',
      'deploy',
    ]);
  });

  it('never falls back to non-versioned deployment for an existing Worker', async () => {
    const runWrangler = runner({
      upload: {
        stdout: '',
        stderr: 'Durable Object migrations require deploy. [code: 10211]',
        status: 1,
      },
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'existing',
        message: encodeCloudflareVersionMessage(['0002_state.sql']),
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'upload-failed',
      status: 1,
      cloudflareErrorCode: 10211,
    });
    expect(runWrangler.mock.calls.some(([args]) => args[0] === 'deploy')).toBe(false);
  });

  it('classifies a Containers entitlement failure during version upload', async () => {
    const runWrangler = runner({
      upload: {
        stdout: '',
        stderr:
          'Authentication error [GET https://api.cloudflare.com/client/v4/accounts/acc/containers/me] status: 403',
        status: 1,
      },
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'sandbox-app',
        message: encodeCloudflareVersionMessage([]),
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'upload-failed',
      status: 1,
      containersUnavailable: true,
    });
  });

  it('classifies a Containers entitlement failure during first-deploy bootstrap', async () => {
    const runWrangler = runner({
      status: { stdout: '', stderr: 'This Worker does not exist. [code: 10007]', status: 1 },
      upload: {
        stdout: '',
        stderr: 'Durable Object migrations require deploy. [code: 10211]',
        status: 1,
      },
      bootstrap: {
        stdout: '',
        stderr:
          'Authentication error [GET https://api.cloudflare.com/client/v4/accounts/acc/containers/me] status: 403',
        status: 1,
      },
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'sandbox-app',
        message: encodeCloudflareVersionMessage([]),
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'bootstrap-failed',
      status: 1,
      containersUnavailable: true,
    });
  });

  it('bootstraps over the placeholder version created while provisioning a first secret', async () => {
    const runWrangler = runner({
      upload: {
        stdout: '',
        stderr: 'Durable Object migrations require deploy. [code: 10211]',
        status: 1,
      },
      bootstrap: ok(`Current Version ID: ${NEXT}\nhttps://first.example.workers.dev`),
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'first-with-secret',
        message: encodeCloudflareVersionMessage(['0001_state.sql']),
        allowFirstDeploymentBootstrap: true,
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({ ok: true, previousVersionId: CURRENT });
    expect(runWrangler.mock.calls.some(([args]) => args[0] === 'deploy')).toBe(true);
  });
});
