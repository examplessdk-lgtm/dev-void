export type PlatformWorkerName = 'proxy' | 'tail' | 'api' | 'dashboard' | 'dispatch';

type PlatformWorkerDef = Readonly<{
  name: PlatformWorkerName;
  prodScript: string;
  stagingScript: string;
  dependsOn: ReadonlyArray<PlatformWorkerName>;
  deployOrder: number;
  rollbackWarning?: string;
}>;

export type PlatformWorker = PlatformWorkerDef & {
  dependedBy: ReadonlyArray<PlatformWorkerName>;
};

const WORKER_DEFS: ReadonlyArray<PlatformWorkerDef> = [
  {
    name: 'proxy',
    prodScript: 'void-proxy',
    stagingScript: 'void-proxy-staging',
    dependsOn: [],
    deployOrder: 1,
  },
  {
    name: 'tail',
    prodScript: 'void-tail',
    stagingScript: 'void-tail-staging',
    dependsOn: [],
    deployOrder: 2,
  },
  {
    name: 'api',
    prodScript: 'void-api',
    stagingScript: 'void-api-staging',
    dependsOn: ['proxy'],
    deployOrder: 3,
    rollbackWarning:
      'Rolling back void-api also rolls back this admin panel. The CF API call completes before the redirect, so the rollback will succeed — but you may lose access to this page afterward. Also note: DB migrations are forward-only. The schema-compat CI job ensures backward compatibility, so old code should work against the newer schema.',
  },
  {
    name: 'dashboard',
    prodScript: 'void-dashboard',
    stagingScript: 'void-dashboard-staging',
    dependsOn: ['api'],
    deployOrder: 4,
  },
  {
    name: 'dispatch',
    prodScript: 'void-dispatch',
    stagingScript: 'void-dispatch-staging',
    dependsOn: ['proxy', 'tail'],
    deployOrder: 5,
  },
];

// Derive dependedBy from dependsOn (single source of truth for the dependency graph)
export const PLATFORM_WORKERS: ReadonlyArray<PlatformWorker> = WORKER_DEFS.map((def) => ({
  ...def,
  dependedBy: WORKER_DEFS.filter((other) => other.dependsOn.includes(def.name)).map(
    (other) => other.name,
  ),
}));

export type PlatformEnv = 'production' | 'staging';

export function parseEnv(raw: string | undefined): PlatformEnv {
  return raw === 'staging' ? 'staging' : 'production';
}

export function getScriptName(worker: PlatformWorker, env: PlatformEnv): string {
  return env === 'staging' ? worker.stagingScript : worker.prodScript;
}

export function getWorkerByName(name: string): PlatformWorker | undefined {
  return PLATFORM_WORKERS.find((w) => w.name === name);
}
