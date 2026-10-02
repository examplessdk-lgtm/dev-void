import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PlatformClient } from '../../src/cli/client.ts';
import { withPlatformDiscovery } from '../helpers/platform-discovery.ts';

const fetchMock = vi.fn();
let originalFetch: typeof globalThis.fetch | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = withPlatformDiscovery(fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
});

const apiUrl = 'https://api.test';
const projectId = 'project_1';

function client(): PlatformClient {
  return new PlatformClient('test-token', { apiUrl });
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function request(index = 0): [string, RequestInit] {
  return fetchMock.mock.calls[index] as [string, RequestInit];
}

describe('PlatformClient project teams', () => {
  it('lists members and project invitations from response envelopes', async () => {
    const member = { user: { id: 'user_1', login: 'alex' }, role: 'admin' };
    const invitation = { id: 'invite_1', role: 'reader' };
    fetchMock.mockResolvedValueOnce(json({ members: [member] }));
    fetchMock.mockResolvedValueOnce(json({ invitations: [invitation] }));

    await expect(client().listProjectMembers(projectId)).resolves.toEqual([member]);
    await expect(client().listProjectInvitations(projectId)).resolves.toEqual([invitation]);
    expect(request(0)[0]).toBe(`${apiUrl}/projects/${projectId}/members`);
    expect(request(1)[0]).toBe(`${apiUrl}/projects/${projectId}/invitations`);
  });

  it('invites only by email and role', async () => {
    const result = {
      invitation: { id: 'invite_1', role: 'collaborator' },
      refreshed: false,
      delivery: { status: 'not_configured' },
    };
    fetchMock.mockResolvedValueOnce(json(result, 201));

    await expect(
      client().inviteProjectMember(projectId, 'alex@example.com', 'collaborator'),
    ).resolves.toEqual(result);
    expect(request()[0]).toBe(`${apiUrl}/projects/${projectId}/invitations`);
    expect(request()[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ email: 'alex@example.com', role: 'collaborator' }),
    });
  });

  it('changes and removes members with encoded user IDs', async () => {
    fetchMock.mockResolvedValueOnce(json({ member: { user: { id: 'user / 1' }, role: 'admin' } }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await client().updateProjectMemberRole(projectId, 'user / 1', 'admin');
    await client().removeProjectMember(projectId, 'user / 1');
    expect(request(0)[0]).toBe(`${apiUrl}/projects/${projectId}/members/user%20%2F%201`);
    expect(request(0)[1]).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(request(1)[1]).toMatchObject({ method: 'DELETE' });
  });

  it('revokes and leaves without parsing 204 responses', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await client().revokeProjectInvitation(projectId, 'invite / 1');
    await client().leaveProject(projectId);
    expect(request(0)[0]).toBe(`${apiUrl}/projects/${projectId}/invitations/invite%20%2F%201`);
    expect(request(1)[0]).toBe(`${apiUrl}/projects/${projectId}/leave`);
  });

  it('lists, accepts, and declines account-bound invitations', async () => {
    const invitation = { id: 'invite_1', project: { id: projectId, slug: 'app' }, role: 'reader' };
    fetchMock.mockResolvedValueOnce(json({ invitations: [invitation] }));
    fetchMock.mockResolvedValueOnce(json({ member: { user: { id: 'user_1' }, role: 'reader' } }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(client().listPendingProjectInvitations()).resolves.toEqual([invitation]);
    await client().respondToProjectInvitation('invite / 1', 'accept');
    await client().respondToProjectInvitation('invite / 1', 'decline');
    expect(request(0)[0]).toBe(`${apiUrl}/me/project-invitations`);
    expect(request(1)[0]).toBe(`${apiUrl}/project-invitations/invite%20%2F%201/accept`);
    expect(request(2)[0]).toBe(`${apiUrl}/project-invitations/invite%20%2F%201/decline`);
  });
});
