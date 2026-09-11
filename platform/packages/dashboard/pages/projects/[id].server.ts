import type { InferResponseType } from 'hono/client';
import { defineHandler } from 'void';
import {
  api,
  createClient,
  readApiJson,
  type API,
  type ApiResponse,
  type Client,
} from '../../lib/api.ts';

type ProjectRoutes = Client['projects'][':id'];

export type Props = Readonly<{
  project: InferResponseType<ProjectRoutes['$get'], 200>;
  deployments: InferResponseType<ProjectRoutes['deployments']['$get'], 200>;
  domains: InferResponseType<ProjectRoutes['domains']['$get'], 200>;
  resources: InferResponseType<ProjectRoutes['resources']['$get'], 200>;
  usage: API<'usage', ProjectRoutes>;
  secrets: API<'secrets', ProjectRoutes>;
  siteDomain: string;
}>;

export const loader = defineHandler<Props>(async (context) => {
  const id = context.req.param('id');
  if (!id) {
    return context.notFound();
  }

  const client = createClient(context);
  let projectRes: ApiResponse;
  try {
    projectRes = await client.projects[':id'].$get({ param: { id } });
  } catch (error) {
    console.warn(
      `[dashboard] /projects/${id} request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return context.notFound();
  }

  if (!projectRes.ok) {
    return context.notFound();
  }
  const project = await readApiJson<Props['project']>(projectRes);
  if (!project) {
    return context.notFound();
  }

  const [deploymentsRes, domainsRes, resourcesRes, usageRes, secretsRes] = await Promise.allSettled(
    [
      client.projects[':id'].deployments.$get({ param: { id } }),
      client.projects[':id'].domains.$get({ param: { id } }),
      client.projects[':id'].resources.$get({ param: { id } }),
      client.projects[':id'].usage.$get({ param: { id } }),
      client.projects[':id'].secrets.$get({ param: { id } }),
    ],
  );

  const readSettled = async <T>(result: PromiseSettledResult<ApiResponse>): Promise<T | null> => {
    if (result.status === 'rejected') {
      console.warn(
        `[dashboard] project detail API request failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      );
      return null;
    }
    return result.value.ok ? readApiJson<T>(result.value) : null;
  };

  return {
    project,
    deployments: (await readSettled<Props['deployments']>(deploymentsRes)) ?? {
      deployments: [],
      activeDeploymentId: project.active_deployment_id,
    },
    domains: (await readSettled<Props['domains']>(domainsRes)) ?? [],
    resources: (await readSettled<Props['resources']>(resourcesRes)) ?? [],
    usage: (await readSettled<Props['usage']>(usageRes)) ?? {
      projectId: id,
      billingPeriodStart: new Date().toISOString(),
      requests: 0,
      bandwidthBytes: 0,
      aiNeurons: 0,
    },
    secrets: (await readSettled<Props['secrets']>(secretsRes)) ?? [],
    siteDomain: (context.env as Record<string, string>).SITE_DOMAIN ?? 'void.app',
  };
});

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export const action = defineHandler(async (context) => {
  const id = context.req.param('id');
  if (!id) {
    return context.notFound();
  }

  const form = await context.req.parseBody();
  const intent = stringValue(form._intent);

  if (intent === 'add-domain') {
    await api(context, `/projects/${id}/domains`, {
      method: 'POST',
      body: JSON.stringify({ hostname: stringValue(form.hostname).trim() }),
    });
  } else if (intent === 'remove-domain') {
    await api(context, `/projects/${id}/domains/${stringValue(form.domainId)}`, {
      method: 'DELETE',
    });
  } else if (intent === 'add-secret') {
    await api(context, `/projects/${id}/secrets/${stringValue(form.name).trim()}`, {
      method: 'PUT',
      body: JSON.stringify({ value: stringValue(form.value) }),
    });
  } else if (intent === 'remove-secret') {
    await api(context, `/projects/${id}/secrets/${stringValue(form.name)}`, {
      method: 'DELETE',
    });
  }

  return context.redirect(`/projects/${id}`);
});
