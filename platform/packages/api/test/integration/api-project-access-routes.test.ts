import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { verifyPrerenderToken } from '../../src/auth/deploy-token.ts';
import app from '../../src/index.ts';
import { projectMembers, projectOwnershipPeriods, users } from '../../src/schema.ts';
import {
  JWT_SECRET,
  clearTables,
  createTestProject,
  createTestUser,
  mockCfApi,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function authed(path: string, jwt: string, method = 'GET'): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt}` },
  });
}

describe('project route membership capabilities', () => {
  it('lists shared projects with role and owner and grants readers view routes', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const reader = await createTestUser(env.db, 'reader');
    const project = await createTestProject(env.db, owner.id, 'shared-reader-app');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: reader.id,
      role: 'reader',
      added_by_user_id: owner.id,
    });
    mockCfApi();

    const listResponse = await app.fetch(authed('/projects', reader.jwt), env);
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toMatchObject([
      {
        id: project.id,
        slug: project.slug,
        role: 'reader',
        owner: { id: owner.id, login: 'owner' },
      },
    ]);

    const detail = await app.fetch(authed(`/projects/${project.id}`, reader.jwt), env);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      id: project.id,
      role: 'reader',
      owner: { id: owner.id },
    });

    const resources = await app.fetch(authed(`/projects/${project.id}/resources`, reader.jwt), env);
    expect(resources.status).toBe(200);
    expect(await resources.json()).toEqual([]);

    const secrets = await app.fetch(authed(`/projects/${project.id}/secrets`, reader.jwt), env);
    expect(secrets.status).toBe(403);
    const deletion = await app.fetch(authed(`/projects/${project.id}`, reader.jwt, 'DELETE'), env);
    expect(deletion.status).toBe(403);
  });

  it('allows collaborators to use deploy prerequisites under the owner account', async () => {
    const owner = await createTestUser(env.db, 'paid-owner', 'github', undefined, 'pro');
    const collaborator = await createTestUser(env.db, 'collaborator');
    const project = await createTestProject(env.db, owner.id, 'shared-deploy-app');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: collaborator.id,
      role: 'collaborator',
      added_by_user_id: owner.id,
    });

    const secrets = await app.fetch(
      authed(`/projects/${project.id}/secrets`, collaborator.jwt),
      env,
    );
    expect(secrets.status).toBe(200);

    const tokenResponse = await app.fetch(
      authed(`/projects/${project.id}/prerender-token`, collaborator.jwt, 'POST'),
      env,
    );
    expect(tokenResponse.status).toBe(200);
    const { token } = (await tokenResponse.json()) as { token: string };
    const payload = await verifyPrerenderToken(token, JWT_SECRET);
    expect(payload).toMatchObject({
      sub: collaborator.id,
      login: collaborator.login,
      project: project.id,
      aud: 'prerender',
    });
  });
});

describe('ownership-period account usage', () => {
  it('queries only the former owner interval that overlaps the billing window', async () => {
    const formerOwner = await createTestUser(env.db, 'former-owner');
    const currentOwner = await createTestUser(env.db, 'current-owner');
    const project = await createTestProject(env.db, currentOwner.id, 'transferred-app');
    const now = Date.now();
    const billingStart = new Date(now - 10 * 24 * 60 * 60 * 1_000);
    const ownedFrom = new Date(now - 8 * 24 * 60 * 60 * 1_000);
    const transferredAt = new Date(now - 2 * 24 * 60 * 60 * 1_000);
    await env.db
      .update(users)
      .set({ billing_cycle_start: billingStart.toISOString() })
      .where(eq(users.id, formerOwner.id));
    await env.db.insert(projectOwnershipPeriods).values([
      {
        id: 'pown_former',
        project_id: project.id,
        owner_user_id: formerOwner.id,
        starts_at: ownedFrom.toISOString(),
        ends_at: transferredAt.toISOString(),
      },
      {
        id: 'pown_current',
        project_id: project.id,
        owner_user_id: currentOwner.id,
        starts_at: transferredAt.toISOString(),
      },
    ]);

    const analyticsQueries: Array<string> = [];
    const graphqlQueries: Array<string> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/analytics_engine/sql')) {
          analyticsQueries.push(String(init?.body));
          return Response.json({
            data: [{ blob1: project.id, requests: 12, bandwidth_bytes: 34 }],
          });
        }
        if (url.includes('/graphql')) {
          const body = JSON.parse(String(init?.body)) as { query: string };
          graphqlQueries.push(body.query);
          return Response.json({
            data: {
              viewer: {
                accounts: [{ aiGatewayRequests: [{ sum: { cost: 0.000022 } }] }],
              },
            },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const response = await app.fetch(authed('/usage', formerOwner.jwt), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      requests: 12,
      bandwidthBytes: 34,
      aiNeurons: 2,
      projects: [{ projectId: project.id, slug: project.slug, aiNeurons: 2 }],
    });
    expect(analyticsQueries).toHaveLength(1);
    expect(analyticsQueries[0]).toContain(ownedFrom.toISOString().replace('T', ' ').slice(0, 19));
    expect(analyticsQueries[0]).toContain(
      transferredAt.toISOString().replace('T', ' ').slice(0, 19),
    );
    expect(graphqlQueries).toHaveLength(1);
    expect(graphqlQueries[0]).toContain(`datetime_geq: "${ownedFrom.toISOString()}"`);
    expect(graphqlQueries[0]).toContain(`datetime_lt: "${transferredAt.toISOString()}"`);
  });

  it('keeps current-owner usage for legacy projects without ownership periods', async () => {
    const owner = await createTestUser(env.db, 'legacy-owner');
    const project = await createTestProject(env.db, owner.id, 'legacy-app');
    const response = await app.fetch(authed('/usage', owner.jwt), {
      ...env,
      DEV_AUTH_BYPASS: 'true',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      projects: [{ projectId: project.id, slug: project.slug }],
    });
  });
});
