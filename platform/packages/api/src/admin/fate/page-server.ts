import {
  dataView,
  FateRequestError,
  resolveSourceById,
  type Entity,
  type SourceDefinition,
  type SourceRegistry,
} from '@nkzw/fate/server';
import type { Context } from 'hono';
import type { ApiEnv } from '../../env.ts';
import { OperatorError } from '../../operator/common.ts';
import {
  loadBuildDetailPage,
  loadAuthEditPage,
  loadAuthNewPage,
  loadAuthSettingsPage,
  loadCliVersionsPage,
  loadDeploymentDetailPage,
  loadDeploymentsPage,
  loadEmailSettingsPage,
  loadEmailProjectPage,
  loadInvitationsPage,
  loadProjectDetailPage,
  loadProjectsPage,
  loadSignupPage,
  loadUserDetailPage,
  loadUsersPage,
  loadZeroTrustPage,
} from './page-data.ts';

type AdminContext = Context<ApiEnv>;
type UsersPageRecord = Awaited<ReturnType<typeof loadUsersPage>>;
type ProjectsPageRecord = Awaited<ReturnType<typeof loadProjectsPage>>;
type DeploymentsPageRecord = Awaited<ReturnType<typeof loadDeploymentsPage>>;
type UserDetailRecord = Awaited<ReturnType<typeof loadUserDetailPage>>;
type ProjectDetailRecord = Awaited<ReturnType<typeof loadProjectDetailPage>>;
type DeploymentDetailRecord = Awaited<ReturnType<typeof loadDeploymentDetailPage>>;
type BuildDetailRecord = Awaited<ReturnType<typeof loadBuildDetailPage>>;
type CliVersionsRecord = Awaited<ReturnType<typeof loadCliVersionsPage>>;
type SignupRecord = Awaited<ReturnType<typeof loadSignupPage>>;
type InvitationsRecord = Awaited<ReturnType<typeof loadInvitationsPage>>;
type AuthSettingsRecord = Awaited<ReturnType<typeof loadAuthSettingsPage>>;
type AuthNewRecord = Awaited<ReturnType<typeof loadAuthNewPage>>;
type AuthEditRecord = Awaited<ReturnType<typeof loadAuthEditPage>>;
type EmailSettingsRecord = Awaited<ReturnType<typeof loadEmailSettingsPage>>;
type EmailProjectRecord = Awaited<ReturnType<typeof loadEmailProjectPage>>;
type ZeroTrustRecord = Awaited<ReturnType<typeof loadZeroTrustPage>>;

export const usersPageDataView = dataView<UsersPageRecord>('AdminUsersPage')({
  id: true,
  users: true,
  search: true,
  page: true,
  totalPages: true,
  tz: true,
});
export const projectsPageDataView = dataView<ProjectsPageRecord>('AdminProjectsPage')({
  id: true,
  projects: true,
  search: true,
  page: true,
  totalPages: true,
  siteDomain: true,
  tz: true,
});
export const deploymentsPageDataView = dataView<DeploymentsPageRecord>('AdminDeploymentsPage')({
  id: true,
  deployments: true,
  search: true,
  page: true,
  totalPages: true,
  tz: true,
});
export const userDetailDataView = dataView<UserDetailRecord>('AdminUserDetail')({
  id: true,
  user: true,
  projects: true,
  deploysToday: true,
  usage: true,
  tz: true,
});
export const projectDetailDataView = dataView<ProjectDetailRecord>('AdminProjectDetail')({
  id: true,
  project: true,
  deployments: true,
  resources: true,
  owner: true,
  teamMembers: true,
  pendingTeamInvitations: true,
  domains: true,
  builds: true,
  zeroTrust: true,
  cfAccountId: true,
  deployUrl: true,
  tz: true,
});
export const deploymentDetailDataView = dataView<DeploymentDetailRecord>('AdminDeploymentDetail')({
  id: true,
  deployment: true,
  project: true,
  manifest: true,
  canCancel: true,
  tz: true,
});
export const buildDetailDataView = dataView<BuildDetailRecord>('AdminBuildDetail')({
  id: true,
  build: true,
  tz: true,
});
export const cliVersionsDataView = dataView<CliVersionsRecord>('AdminCliVersions')({
  id: true,
  allTime: true,
  last30Days: true,
  tz: true,
});
export const signupDataView = dataView<SignupRecord>('AdminSignup')({
  id: true,
  enabled: true,
  entries: true,
  directEntries: true,
  admission: true,
  connections: true,
  initialized: true,
  revision: true,
  methods: true,
  protection: true,
  invitations: true,
  page: true,
  totalPages: true,
  emailEnabled: true,
  connectCommand: true,
  inviteUrl: true,
  result: true,
  tz: true,
});
export const invitationsDataView = dataView<InvitationsRecord>('AdminInvitations')({
  id: true,
  invitations: true,
  page: true,
  totalPages: true,
  tz: true,
});
export const authSettingsDataView = dataView<AuthSettingsRecord>('AdminAuthSettings')({
  id: true,
  data: true,
  tested: true,
});
export const authNewDataView = dataView<AuthNewRecord>('AdminAuthNew')({
  id: true,
  kind: true,
  connectionId: true,
  callbackUrl: true,
});
export const authEditDataView = dataView<AuthEditRecord>('AdminAuthEdit')({
  id: true,
  configuration: true,
  label: true,
  revision: true,
  callbackUrl: true,
});
export const emailSettingsDataView = dataView<EmailSettingsRecord>('AdminEmailSettings')({
  id: true,
  policy: true,
  management: true,
  senderDomain: true,
});
export const emailProjectDataView = dataView<EmailProjectRecord>('AdminEmailProject')({
  id: true,
  projectId: true,
  project: true,
  month: true,
  attempts: true,
  received: true,
  monthlyLimit: true,
  burstLimit: true,
  isSuspended: true,
  domains: true,
  destinations: true,
  senderDomain: true,
  tz: true,
});
export const zeroTrustDataView = dataView<ZeroTrustRecord>('AdminZeroTrust')({
  id: true,
  configured: true,
  enabled: true,
  status: true,
  accountId: true,
  defaultAccountId: true,
  teamDomain: true,
  identityProviderIds: true,
  policyIds: true,
  protectNewProjects: true,
  operation: true,
  lastError: true,
  live: true,
  projects: true,
});

export type AdminUsersPage = Entity<typeof usersPageDataView, 'AdminUsersPage'>;
export type AdminProjectsPage = Entity<typeof projectsPageDataView, 'AdminProjectsPage'>;
export type AdminDeploymentsPage = Entity<typeof deploymentsPageDataView, 'AdminDeploymentsPage'>;
export type AdminUserDetail = Entity<typeof userDetailDataView, 'AdminUserDetail'>;
export type AdminProjectDetail = Entity<typeof projectDetailDataView, 'AdminProjectDetail'>;
export type AdminDeploymentDetail = Entity<
  typeof deploymentDetailDataView,
  'AdminDeploymentDetail'
>;
export type AdminBuildDetail = Entity<typeof buildDetailDataView, 'AdminBuildDetail'>;
export type AdminCliVersions = Entity<typeof cliVersionsDataView, 'AdminCliVersions'>;
export type AdminSignup = Entity<typeof signupDataView, 'AdminSignup'>;
export type AdminInvitations = Entity<typeof invitationsDataView, 'AdminInvitations'>;
export type AdminAuthSettings = Entity<typeof authSettingsDataView, 'AdminAuthSettings'>;
export type AdminAuthNew = Entity<typeof authNewDataView, 'AdminAuthNew'>;
export type AdminAuthEdit = Entity<typeof authEditDataView, 'AdminAuthEdit'>;
export type AdminEmailSettings = Entity<typeof emailSettingsDataView, 'AdminEmailSettings'>;
export type AdminEmailProject = Entity<typeof emailProjectDataView, 'AdminEmailProject'>;
export type AdminZeroTrust = Entity<typeof zeroTrustDataView, 'AdminZeroTrust'>;

const usersSource: SourceDefinition<UsersPageRecord> = { id: 'id', view: usersPageDataView };
const projectsSource: SourceDefinition<ProjectsPageRecord> = {
  id: 'id',
  view: projectsPageDataView,
};
const deploymentsSource: SourceDefinition<DeploymentsPageRecord> = {
  id: 'id',
  view: deploymentsPageDataView,
};
const userDetailSource: SourceDefinition<UserDetailRecord> = { id: 'id', view: userDetailDataView };
const projectDetailSource: SourceDefinition<ProjectDetailRecord> = {
  id: 'id',
  view: projectDetailDataView,
};
const deploymentDetailSource: SourceDefinition<DeploymentDetailRecord> = {
  id: 'id',
  view: deploymentDetailDataView,
};
const buildDetailSource: SourceDefinition<BuildDetailRecord> = {
  id: 'id',
  view: buildDetailDataView,
};
const cliVersionsSource: SourceDefinition<CliVersionsRecord> = {
  id: 'id',
  view: cliVersionsDataView,
};
const signupSource: SourceDefinition<SignupRecord> = { id: 'id', view: signupDataView };
const invitationsSource: SourceDefinition<InvitationsRecord> = {
  id: 'id',
  view: invitationsDataView,
};
const authSettingsSource: SourceDefinition<AuthSettingsRecord> = {
  id: 'id',
  view: authSettingsDataView,
};
const authNewSource: SourceDefinition<AuthNewRecord> = { id: 'id', view: authNewDataView };
const authEditSource: SourceDefinition<AuthEditRecord> = { id: 'id', view: authEditDataView };
const emailSettingsSource: SourceDefinition<EmailSettingsRecord> = {
  id: 'id',
  view: emailSettingsDataView,
};
const emailProjectSource: SourceDefinition<EmailProjectRecord> = {
  id: 'id',
  view: emailProjectDataView,
};
const zeroTrustSource: SourceDefinition<ZeroTrustRecord> = { id: 'id', view: zeroTrustDataView };

export const pageSourceByType = new Map<string, SourceDefinition>([
  ['AdminUsersPage', usersSource],
  ['AdminProjectsPage', projectsSource],
  ['AdminDeploymentsPage', deploymentsSource],
  ['AdminUserDetail', userDetailSource],
  ['AdminProjectDetail', projectDetailSource],
  ['AdminDeploymentDetail', deploymentDetailSource],
  ['AdminBuildDetail', buildDetailSource],
  ['AdminCliVersions', cliVersionsSource],
  ['AdminSignup', signupSource],
  ['AdminInvitations', invitationsSource],
  ['AdminAuthSettings', authSettingsSource],
  ['AdminAuthNew', authNewSource],
  ['AdminAuthEdit', authEditSource],
  ['AdminEmailSettings', emailSettingsSource],
  ['AdminEmailProject', emailProjectSource],
  ['AdminZeroTrust', zeroTrustSource],
]);

export const pageRegistry: SourceRegistry<AdminContext> = new Map();
async function loadPages<Item>(
  context: AdminContext,
  ids: Array<string>,
  loader: (context: AdminContext, path: string) => Promise<Item>,
): Promise<Array<Item>> {
  try {
    return await Promise.all(ids.map((id) => loader(context, id)));
  } catch (error) {
    if (error instanceof OperatorError) {
      throw new FateRequestError(
        error.status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST',
        error.message,
        {
          status: error.status,
        },
      );
    }
    throw error;
  }
}
pageRegistry.set(usersSource, {
  byIds: async ({ ctx, ids }) => loadPages(ctx, ids, loadUsersPage),
});
pageRegistry.set(projectsSource, {
  byIds: async ({ ctx, ids }) => loadPages(ctx, ids, loadProjectsPage),
});
pageRegistry.set(deploymentsSource, {
  byIds: async ({ ctx, ids }) => loadPages(ctx, ids, loadDeploymentsPage),
});
pageRegistry.set(userDetailSource, {
  byIds: async ({ ctx, ids }) => loadPages(ctx, ids, loadUserDetailPage),
});
pageRegistry.set(projectDetailSource, {
  byIds: async ({ ctx, ids }) => loadPages(ctx, ids, loadProjectDetailPage),
});
pageRegistry.set(deploymentDetailSource, {
  byIds: async ({ ctx, ids }) => loadPages(ctx, ids, loadDeploymentDetailPage),
});
pageRegistry.set(buildDetailSource, {
  byIds: async ({ ctx, ids }) => loadPages(ctx, ids, loadBuildDetailPage),
});
pageRegistry.set(cliVersionsSource, {
  byIds: async ({ ctx, ids }) => loadPages(ctx, ids, loadCliVersionsPage),
});
pageRegistry.set(signupSource, {
  byIds: async ({ ctx, ids }) => loadPages(ctx, ids, loadSignupPage),
});
pageRegistry.set(invitationsSource, {
  byIds: async ({ ctx, ids }) => loadPages(ctx, ids, loadInvitationsPage),
});
pageRegistry.set(authSettingsSource, {
  byIds: async ({ ctx, ids }) => loadPages(ctx, ids, loadAuthSettingsPage),
});
pageRegistry.set(authNewSource, {
  byIds: async ({ ctx, ids }) => loadPages(ctx, ids, loadAuthNewPage),
});
pageRegistry.set(authEditSource, {
  byIds: async ({ ctx, ids }) => loadPages(ctx, ids, loadAuthEditPage),
});
pageRegistry.set(emailSettingsSource, {
  byIds: async ({ ctx, ids }) => loadPages(ctx, ids, loadEmailSettingsPage),
});
pageRegistry.set(emailProjectSource, {
  byIds: async ({ ctx, ids }) => loadPages(ctx, ids, loadEmailProjectPage),
});
pageRegistry.set(zeroTrustSource, {
  byIds: async ({ ctx, ids }) => loadPages(ctx, ids, loadZeroTrustPage),
});

function pagePath(input: { args?: Record<string, unknown> }) {
  const path = input.args?.path;
  if (typeof path !== 'string') {
    throw new Error('Admin page path is required.');
  }
  return path;
}

export const PageRoot = {
  usersPage: usersPageDataView,
  projectsPage: projectsPageDataView,
  deploymentsPage: deploymentsPageDataView,
  userDetail: userDetailDataView,
  projectDetail: projectDetailDataView,
  deploymentDetail: deploymentDetailDataView,
  buildDetail: buildDetailDataView,
  cliVersions: cliVersionsDataView,
  signupControl: signupDataView,
  invitations: invitationsDataView,
  authSettings: authSettingsDataView,
  authNew: authNewDataView,
  authEdit: authEditDataView,
  emailSettings: emailSettingsDataView,
  emailProject: emailProjectDataView,
  zeroTrust: zeroTrustDataView,
};

export const pageQueries = {
  usersPage: {
    resolve: ({
      ctx,
      input,
      select,
    }: {
      ctx: AdminContext;
      input: { args?: Record<string, unknown> };
      select: Array<string>;
    }) =>
      resolveSourceById({
        ctx,
        id: pagePath(input),
        input: { select },
        registry: pageRegistry,
        source: usersSource,
      }),
  },
  projectsPage: {
    resolve: ({
      ctx,
      input,
      select,
    }: {
      ctx: AdminContext;
      input: { args?: Record<string, unknown> };
      select: Array<string>;
    }) =>
      resolveSourceById({
        ctx,
        id: pagePath(input),
        input: { select },
        registry: pageRegistry,
        source: projectsSource,
      }),
  },
  deploymentsPage: {
    resolve: ({
      ctx,
      input,
      select,
    }: {
      ctx: AdminContext;
      input: { args?: Record<string, unknown> };
      select: Array<string>;
    }) =>
      resolveSourceById({
        ctx,
        id: pagePath(input),
        input: { select },
        registry: pageRegistry,
        source: deploymentsSource,
      }),
  },
  userDetail: {
    resolve: ({
      ctx,
      input,
      select,
    }: {
      ctx: AdminContext;
      input: { args?: Record<string, unknown> };
      select: Array<string>;
    }) =>
      resolveSourceById({
        ctx,
        id: pagePath(input),
        input: { select },
        registry: pageRegistry,
        source: userDetailSource,
      }),
  },
  projectDetail: {
    resolve: ({
      ctx,
      input,
      select,
    }: {
      ctx: AdminContext;
      input: { args?: Record<string, unknown> };
      select: Array<string>;
    }) =>
      resolveSourceById({
        ctx,
        id: pagePath(input),
        input: { select },
        registry: pageRegistry,
        source: projectDetailSource,
      }),
  },
  deploymentDetail: {
    resolve: ({
      ctx,
      input,
      select,
    }: {
      ctx: AdminContext;
      input: { args?: Record<string, unknown> };
      select: Array<string>;
    }) =>
      resolveSourceById({
        ctx,
        id: pagePath(input),
        input: { select },
        registry: pageRegistry,
        source: deploymentDetailSource,
      }),
  },
  buildDetail: {
    resolve: ({
      ctx,
      input,
      select,
    }: {
      ctx: AdminContext;
      input: { args?: Record<string, unknown> };
      select: Array<string>;
    }) =>
      resolveSourceById({
        ctx,
        id: pagePath(input),
        input: { select },
        registry: pageRegistry,
        source: buildDetailSource,
      }),
  },
  cliVersions: {
    resolve: ({
      ctx,
      input,
      select,
    }: {
      ctx: AdminContext;
      input: { args?: Record<string, unknown> };
      select: Array<string>;
    }) =>
      resolveSourceById({
        ctx,
        id: pagePath(input),
        input: { select },
        registry: pageRegistry,
        source: cliVersionsSource,
      }),
  },
  signupControl: {
    resolve: ({
      ctx,
      input,
      select,
    }: {
      ctx: AdminContext;
      input: { args?: Record<string, unknown> };
      select: Array<string>;
    }) =>
      resolveSourceById({
        ctx,
        id: pagePath(input),
        input: { select },
        registry: pageRegistry,
        source: signupSource,
      }),
  },
  invitations: {
    resolve: ({
      ctx,
      input,
      select,
    }: {
      ctx: AdminContext;
      input: { args?: Record<string, unknown> };
      select: Array<string>;
    }) =>
      resolveSourceById({
        ctx,
        id: pagePath(input),
        input: { select },
        registry: pageRegistry,
        source: invitationsSource,
      }),
  },
  authSettings: {
    resolve: ({
      ctx,
      input,
      select,
    }: {
      ctx: AdminContext;
      input: { args?: Record<string, unknown> };
      select: Array<string>;
    }) =>
      resolveSourceById({
        ctx,
        id: pagePath(input),
        input: { select },
        registry: pageRegistry,
        source: authSettingsSource,
      }),
  },
  authNew: {
    resolve: ({
      ctx,
      input,
      select,
    }: {
      ctx: AdminContext;
      input: { args?: Record<string, unknown> };
      select: Array<string>;
    }) =>
      resolveSourceById({
        ctx,
        id: pagePath(input),
        input: { select },
        registry: pageRegistry,
        source: authNewSource,
      }),
  },
  authEdit: {
    resolve: ({
      ctx,
      input,
      select,
    }: {
      ctx: AdminContext;
      input: { args?: Record<string, unknown> };
      select: Array<string>;
    }) =>
      resolveSourceById({
        ctx,
        id: pagePath(input),
        input: { select },
        registry: pageRegistry,
        source: authEditSource,
      }),
  },
  emailSettings: {
    resolve: ({
      ctx,
      input,
      select,
    }: {
      ctx: AdminContext;
      input: { args?: Record<string, unknown> };
      select: Array<string>;
    }) =>
      resolveSourceById({
        ctx,
        id: pagePath(input),
        input: { select },
        registry: pageRegistry,
        source: emailSettingsSource,
      }),
  },
  emailProject: {
    resolve: ({
      ctx,
      input,
      select,
    }: {
      ctx: AdminContext;
      input: { args?: Record<string, unknown> };
      select: Array<string>;
    }) =>
      resolveSourceById({
        ctx,
        id: pagePath(input),
        input: { select },
        registry: pageRegistry,
        source: emailProjectSource,
      }),
  },
  zeroTrust: {
    resolve: ({
      ctx,
      input,
      select,
    }: {
      ctx: AdminContext;
      input: { args?: Record<string, unknown> };
      select: Array<string>;
    }) =>
      resolveSourceById({
        ctx,
        id: pagePath(input),
        input: { select },
        registry: pageRegistry,
        source: zeroTrustSource,
      }),
  },
};
