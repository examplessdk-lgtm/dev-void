import { and, eq } from 'drizzle-orm';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vite-plus/test';
import { upsertContainerResource } from '../../src/db.ts';
import { resources } from '../../src/schema.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
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
});

describe('upsertContainerResource', () => {
  it('inserts a new container resource row when none exists', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    const result = await upsertContainerResource(env.db, project.id, 'SANDBOX', 'new-app-id');

    expect(result.priorCfId).toBeNull();
    const rows = await env.db
      .select()
      .from(resources)
      .where(
        and(
          eq(resources.project_id, project.id),
          eq(resources.type, 'container'),
          eq(resources.binding_name, 'SANDBOX'),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].cf_id).toBe('new-app-id');
  });

  it('no-ops when an existing row already points at the same cf_id', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await env.db.insert(resources).values({
      id: 'res_existing_same',
      project_id: project.id,
      type: 'container',
      cf_id: 'same-app-id',
      binding_name: 'SANDBOX',
    });

    const result = await upsertContainerResource(env.db, project.id, 'SANDBOX', 'same-app-id');

    expect(result.priorCfId).toBe('same-app-id');
    const rows = await env.db.select().from(resources).where(eq(resources.project_id, project.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].cf_id).toBe('same-app-id');
    // Same row preserved (id unchanged).
    expect(rows[0].id).toBe('res_existing_same');
  });

  it('updates cf_id in place when a CF-replaced application returns a new id', async () => {
    // Regression: Codex final review on fix/sandbox-deployment flagged that
    // POST-created replacement container apps were not reconciled back into
    // the resources table. Pre-fix: `deploySandboxContainer` checked whether
    // any container row existed for the binding and skipped persistence if
    // so, leaving the DB pointing at the dead `old-app-id`. Cleanup later
    // 404s on that id and the freshly POST-created `new-app-id` leaks.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await env.db.insert(resources).values({
      id: 'res_existing_replaced',
      project_id: project.id,
      type: 'container',
      cf_id: 'old-app-id',
      binding_name: 'SANDBOX',
    });

    const result = await upsertContainerResource(env.db, project.id, 'SANDBOX', 'new-app-id');

    expect(result.priorCfId).toBe('old-app-id');
    const rows = await env.db.select().from(resources).where(eq(resources.project_id, project.id));
    expect(rows).toHaveLength(1);
    // The row is updated in place (same id, new cf_id) so cleanup —
    // which loads `resources` rows and calls
    // `deleteContainerApplication(resource.cf_id)` — targets the live app
    // rather than 404ing on a stale id.
    expect(rows[0].id).toBe('res_existing_replaced');
    expect(rows[0].cf_id).toBe('new-app-id');
  });

  it('scopes upsert by (project_id, type, binding_name) — does not collide with other projects or bindings', async () => {
    const user = await createTestUser(env.db);
    const projectA = await createTestProject(env.db, user.id, 'project-a');
    const projectB = await createTestProject(env.db, user.id, 'project-b');

    // Same binding_name on a DIFFERENT project — must not be touched.
    await env.db.insert(resources).values({
      id: 'res_other_project',
      project_id: projectB.id,
      type: 'container',
      cf_id: 'other-project-app-id',
      binding_name: 'SANDBOX',
    });
    // Same project + same binding_name but different TYPE — must not be touched.
    await env.db.insert(resources).values({
      id: 'res_other_type',
      project_id: projectA.id,
      type: 'kv',
      cf_id: 'kv-id',
      binding_name: 'SANDBOX',
    });
    // Same project + same type but different BINDING — must not be touched.
    await env.db.insert(resources).values({
      id: 'res_other_binding',
      project_id: projectA.id,
      type: 'container',
      cf_id: 'other-binding-app-id',
      binding_name: 'OTHER_SANDBOX',
    });

    const result = await upsertContainerResource(
      env.db,
      projectA.id,
      'SANDBOX',
      'project-a-new-id',
    );

    expect(result.priorCfId).toBeNull();
    const all = await env.db.select().from(resources);
    const byId = new Map(all.map((r) => [r.id, r]));
    expect(byId.get('res_other_project')?.cf_id).toBe('other-project-app-id');
    expect(byId.get('res_other_type')?.cf_id).toBe('kv-id');
    expect(byId.get('res_other_binding')?.cf_id).toBe('other-binding-app-id');
    // New row inserted for projectA + container + SANDBOX.
    const projectASandbox = all.find(
      (r) => r.project_id === projectA.id && r.type === 'container' && r.binding_name === 'SANDBOX',
    );
    expect(projectASandbox?.cf_id).toBe('project-a-new-id');
  });
});
