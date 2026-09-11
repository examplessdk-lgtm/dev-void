import { cfFetch, CF_API_BASE } from './cloudflare-api.ts';

export type WorkerVersion = Readonly<{
  id: string;
  number: number;
  metadata: {
    created_on: string;
    author_email: string;
  };
}>;

export type DeploymentVersionEntry = Readonly<{
  version_id: string;
  percentage: number;
}>;

export type WorkerDeployment = Readonly<{
  id: string;
  versions: ReadonlyArray<DeploymentVersionEntry>;
  created_on: string;
  author_email: string;
}>;

export async function listWorkerVersions(
  accountId: string,
  apiToken: string,
  scriptName: string,
): Promise<{ items: ReadonlyArray<WorkerVersion> }> {
  return cfFetch<{ items: ReadonlyArray<WorkerVersion> }>(
    `${CF_API_BASE}/${accountId}/workers/scripts/${scriptName}/versions`,
    apiToken,
  );
}

export async function listWorkerDeployments(
  accountId: string,
  apiToken: string,
  scriptName: string,
): Promise<{ deployments: ReadonlyArray<WorkerDeployment> }> {
  return cfFetch<{ deployments: ReadonlyArray<WorkerDeployment> }>(
    `${CF_API_BASE}/${accountId}/workers/scripts/${scriptName}/deployments`,
    apiToken,
  );
}

export async function createWorkerDeployment(
  accountId: string,
  apiToken: string,
  scriptName: string,
  versionId: string,
): Promise<WorkerDeployment> {
  return cfFetch<WorkerDeployment>(
    `${CF_API_BASE}/${accountId}/workers/scripts/${scriptName}/deployments`,
    apiToken,
    {
      method: 'POST',
      body: JSON.stringify({
        strategy: 'percentage',
        versions: [{ version_id: versionId, percentage: 100 }],
      }),
    },
  );
}
