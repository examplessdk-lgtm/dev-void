import { intro, log, note, outro } from '@clack/prompts';
import { getToken } from './auth.ts';
import {
  PlatformClient,
  type ProjectInvitationResponse,
  type ProjectMemberResponse,
} from './client.ts';
import { cliTitle } from './output.ts';
import type { ProjectArgs } from './project-args.ts';
import { readProjectConfig } from './project.ts';
import { getRequestedProjectSlug, resolveProjectBySlug } from './resolve-project.ts';

type ProjectTeamArgs = Exclude<Extract<ProjectArgs, { subcommand: 'team' }>, { action: '' }>;

function clean(value: string | null | undefined): string {
  // Tenant text must not execute terminal control sequences.
  // eslint-disable-next-line no-control-regex
  return (value ?? '—').replace(/[\u0000-\u001f\u007f]/g, ' ');
}

function memberLines(members: Array<ProjectMemberResponse>): string {
  const rows = members.map((member) => ({
    id: member.user.id,
    login: member.user.login ?? '—',
    email: member.user.email ?? '—',
    role: member.role,
  }));
  const widths = {
    id: Math.max(2, ...rows.map((row) => clean(row.id).length)),
    login: Math.max(5, ...rows.map((row) => clean(row.login).length)),
    email: Math.max(5, ...rows.map((row) => clean(row.email).length)),
  };
  return [
    `${'ID'.padEnd(widths.id)}  ${'LOGIN'.padEnd(widths.login)}  ${'EMAIL'.padEnd(widths.email)}  ROLE`,
    ...rows.map(
      (row) =>
        `${clean(row.id).padEnd(widths.id)}  ${clean(row.login).padEnd(widths.login)}  ${clean(row.email).padEnd(widths.email)}  ${row.role}`,
    ),
  ].join('\n');
}

function invitationEmail(invitation: ProjectInvitationResponse): string {
  return invitation.target?.email ?? invitation.target_email ?? '—';
}

function invitationLines(invitations: Array<ProjectInvitationResponse>, pending: boolean): string {
  return invitations
    .map((invitation) => {
      const project = pending ? `  ${clean(invitation.project?.slug)}` : '';
      const target = pending ? '' : `  ${clean(invitationEmail(invitation))}`;
      const status = pending ? '' : `  ${invitation.status ?? 'pending'}`;
      return `${clean(invitation.id)}${project}${target}  ${invitation.role}${status}  expires ${clean(invitation.expires_at)}`;
    })
    .join('\n');
}

async function resolveProjectId(
  root: string,
  client: PlatformClient,
  projectSlug: string,
): Promise<string> {
  const requestedSlug = getRequestedProjectSlug({ projectSlug });
  if (requestedSlug) {
    const project = resolveProjectBySlug(await client.listProjects(), requestedSlug);
    if (!project) {
      throw new Error(`project: No project found with slug '${requestedSlug}'.`);
    }
    return project.projectId;
  }
  const linked = readProjectConfig(root);
  if (!linked) {
    throw new Error('No linked project. Run `void project link` or pass --project <slug>.');
  }
  return linked.projectId;
}

export async function runProjectTeamCommand(root: string, args: ProjectTeamArgs): Promise<void> {
  console.log();
  intro(cliTitle(`project team ${args.action}`));

  const token = getToken(root);
  if (!token) {
    log.error('Not logged in. Run `void auth login` first.');
    process.exit(1);
  }
  const client = new PlatformClient(token, { root });

  if (args.action === 'pending') {
    const invitations = await client.listPendingProjectInvitations();
    if (invitations.length === 0) {
      outro('No pending project invitations.');
      return;
    }
    note(invitationLines(invitations, true), 'Pending Project Invitations');
    outro(`${invitations.length} invitation(s)`);
    return;
  }
  if (args.action === 'accept' || args.action === 'decline') {
    await client.respondToProjectInvitation(args.invitationId, args.action);
    outro(`Project invitation ${args.action === 'accept' ? 'accepted' : 'declined'}.`);
    return;
  }

  const projectId = await resolveProjectId(
    root,
    client,
    'projectSlug' in args ? args.projectSlug : '',
  );
  if (args.action === 'list') {
    const members = await client.listProjectMembers(projectId);
    if (members.length === 0) {
      outro('No project members found.');
      return;
    }
    note(memberLines(members), 'Project Team');
    outro(`${members.length} member(s)`);
    return;
  }
  if (args.action === 'invitations') {
    const invitations = await client.listProjectInvitations(projectId);
    if (invitations.length === 0) {
      outro('No project invitations found.');
      return;
    }
    note(invitationLines(invitations, false), 'Project Invitations');
    outro(`${invitations.length} invitation(s)`);
    return;
  }
  if (args.action === 'invite') {
    const result = await client.inviteProjectMember(projectId, args.email, args.role);
    const delivery =
      result.delivery.status === 'sent'
        ? ''
        : ` (email delivery: ${result.delivery.status.replace('_', ' ')})`;
    outro(`Invited ${invitationEmail(result.invitation)} as ${args.role}${delivery}.`);
    return;
  }
  if (args.action === 'role') {
    await client.updateProjectMemberRole(projectId, args.userId, args.role);
    outro(`Changed ${args.userId} to ${args.role}.`);
    return;
  }
  if (args.action === 'remove') {
    await client.removeProjectMember(projectId, args.userId);
    outro(`Removed ${args.userId} from the project.`);
    return;
  }
  if (args.action === 'revoke') {
    await client.revokeProjectInvitation(projectId, args.invitationId);
    outro(`Revoked invitation ${args.invitationId}.`);
    return;
  }
  await client.leaveProject(projectId);
  outro('Left the project.');
}
