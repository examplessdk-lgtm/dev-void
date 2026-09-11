import { defineHandler } from 'void';
import { createClient, readApiJson, type API } from '../lib/api.ts';

export type Props =
  | {
      canAccessDashboard: false;
      user: API<'me'>;
    }
  | {
      canAccessDashboard: true;
      user: API<'me'>;
      projects: API<'projects'>;
      siteDomain: string;
    };

export const loader = defineHandler<Props>(async (context) => {
  const user = context.get('dashboardUser');
  if (!context.get('canAccessDashboard')) {
    return { canAccessDashboard: false, user };
  }

  const client = createClient(context);
  let projects: API<'projects'> = [];
  try {
    const projectsRes = await client.projects.$get();
    projects = projectsRes.ok ? ((await readApiJson<API<'projects'>>(projectsRes)) ?? []) : [];
  } catch (error) {
    console.warn(
      `[dashboard] /projects request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const siteDomain = (context.env as Record<string, string>).SITE_DOMAIN ?? 'void.app';

  return {
    canAccessDashboard: true,
    user,
    projects,
    siteDomain,
  };
});
