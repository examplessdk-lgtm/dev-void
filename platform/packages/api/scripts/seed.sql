-- Shared seed data for local dev
-- Local: psql -d void_api_dev -f scripts/seed.sql

-- Users
INSERT INTO users (id, provider, provider_id, login, email, plan, billing_cycle_start, suspended_reason, role, created_at) VALUES ('user_seed1', 'github', '100001', 'alice', 'alice@example.com', 'free', '2026-01-21T00:00:00.000Z', NULL, 'user', '2025-11-22T00:00:00.000Z') ON CONFLICT (id) DO NOTHING;
INSERT INTO users (id, provider, provider_id, login, email, plan, billing_cycle_start, suspended_reason, role, created_at) VALUES ('user_seed2', 'github', '100002', 'bob', 'bob@example.com', 'solo', '2026-02-13T00:00:00.000Z', NULL, 'user', '2025-12-22T00:00:00.000Z') ON CONFLICT (id) DO NOTHING;
INSERT INTO users (id, provider, provider_id, login, email, plan, billing_cycle_start, suspended_reason, role, created_at) VALUES ('user_seed3', 'google', '100003', 'carol', 'carol@example.com', 'pro', '2025-12-22T00:00:00.000Z', NULL, 'user', '2025-12-22T00:00:00.000Z') ON CONFLICT (id) DO NOTHING;
INSERT INTO users (id, provider, provider_id, login, email, plan, billing_cycle_start, suspended_reason, role, created_at) VALUES ('user_seed4', 'github', '100004', 'dave', 'dave@example.com', 'sponsored', '2025-11-22T00:00:00.000Z', NULL, 'user', '2025-11-22T00:00:00.000Z') ON CONFLICT (id) DO NOTHING;
INSERT INTO users (id, provider, provider_id, login, email, plan, billing_cycle_start, suspended_reason, role, created_at) VALUES ('user_seed5', 'google', '100005', 'eve', 'eve@example.com', 'free', '2026-01-21T00:00:00.000Z', 'usage_limit_exceeded', 'user', '2026-01-21T00:00:00.000Z') ON CONFLICT (id) DO NOTHING;

-- Projects
INSERT INTO projects (id, user_id, slug, mode, created_at) VALUES ('proj_seed00000001', 'user_seed1', 'my-app', 'void', now() - interval '60 days') ON CONFLICT (id) DO NOTHING;
INSERT INTO projects (id, user_id, slug, mode, created_at) VALUES ('proj_seed00000002', 'user_seed1', 'docs-site', 'static', now() - interval '60 days') ON CONFLICT (id) DO NOTHING;
INSERT INTO projects (id, user_id, slug, mode, created_at) VALUES ('proj_seed00000003', 'user_seed2', 'api-service', 'void', now() - interval '60 days') ON CONFLICT (id) DO NOTHING;
INSERT INTO projects (id, user_id, slug, mode, created_at) VALUES ('proj_seed00000004', 'user_seed2', 'landing-page', 'spa', now() - interval '60 days') ON CONFLICT (id) DO NOTHING;
INSERT INTO projects (id, user_id, slug, mode, created_at) VALUES ('proj_seed00000005', 'user_seed3', 'dashboard', 'framework', now() - interval '60 days') ON CONFLICT (id) DO NOTHING;
INSERT INTO projects (id, user_id, slug, mode, created_at) VALUES ('proj_seed00000006', 'user_seed4', 'blog', 'static', now() - interval '60 days') ON CONFLICT (id) DO NOTHING;

-- Deployments (live)
INSERT INTO deployments (id, project_id, status, manifest, error_message, created_at, deployed_at) VALUES ('dpl_seed1', 'proj_seed00000001', 'live', '{"bindings":{"d1":["DB"],"kv":["CACHE"]},"migrations":[{"name":"001_create_users.sql","destructive":false}]}', NULL, now() - interval '30 days', now() - interval '30 days') ON CONFLICT (id) DO NOTHING;
INSERT INTO deployments (id, project_id, status, manifest, error_message, created_at, deployed_at) VALUES ('dpl_seed2', 'proj_seed00000001', 'live', NULL, NULL, now() - interval '7 days', now() - interval '7 days') ON CONFLICT (id) DO NOTHING;
INSERT INTO deployments (id, project_id, status, manifest, error_message, created_at, deployed_at) VALUES ('dpl_seed3', 'proj_seed00000002', 'live', NULL, NULL, now() - interval '60 days', now() - interval '60 days') ON CONFLICT (id) DO NOTHING;
INSERT INTO deployments (id, project_id, status, manifest, error_message, created_at, deployed_at) VALUES ('dpl_seed4', 'proj_seed00000003', 'live', '{"bindings":{"d1":["DB"],"r2":["UPLOADS"]},"migrations":[{"name":"001_create_orders.sql","destructive":false},{"name":"002_add_status.sql","destructive":false}]}', NULL, now() - interval '30 days', now() - interval '30 days') ON CONFLICT (id) DO NOTHING;
INSERT INTO deployments (id, project_id, status, manifest, error_message, created_at, deployed_at) VALUES ('dpl_seed5', 'proj_seed00000003', 'live', NULL, NULL, now() - interval '7 days', now() - interval '7 days') ON CONFLICT (id) DO NOTHING;
INSERT INTO deployments (id, project_id, status, manifest, error_message, created_at, deployed_at) VALUES ('dpl_seed6', 'proj_seed00000004', 'live', NULL, NULL, now() - interval '60 days', now() - interval '60 days') ON CONFLICT (id) DO NOTHING;
INSERT INTO deployments (id, project_id, status, manifest, error_message, created_at, deployed_at) VALUES ('dpl_seed7', 'proj_seed00000005', 'live', '{"bindings":{"d1":["DB"],"kv":["SESSIONS"],"r2":["ASSETS"]},"schedules":["0 */6 * * *"]}', NULL, now() - interval '30 days', now() - interval '30 days') ON CONFLICT (id) DO NOTHING;
INSERT INTO deployments (id, project_id, status, manifest, error_message, created_at, deployed_at) VALUES ('dpl_seed8', 'proj_seed00000006', 'live', '{"bindings":{"kv":["CACHE"]}}', NULL, now() - interval '7 days', now() - interval '7 days') ON CONFLICT (id) DO NOTHING;

-- Deployments (failed)
INSERT INTO deployments (id, project_id, status, manifest, error_message, created_at, deployed_at) VALUES ('dpl_fail1', 'proj_seed00000001', 'failed', NULL, 'destructive migration rejected: 003_drop_users.sql', now() - interval '7 days', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO deployments (id, project_id, status, manifest, error_message, created_at, deployed_at) VALUES ('dpl_fail2', 'proj_seed00000003', 'failed', NULL, 'migration failed: no such table: orders', now() - interval '30 days', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO deployments (id, project_id, status, manifest, error_message, created_at, deployed_at) VALUES ('dpl_fail3', 'proj_seed00000005', 'failed', NULL, 'worker upload failed: 500 Internal Server Error', now() - interval '60 days', NULL) ON CONFLICT (id) DO NOTHING;

-- Today's deployments (deploy count demo)
INSERT INTO deployments (id, project_id, status, manifest, error_message, created_at, deployed_at) VALUES ('dpl_today1', 'proj_seed00000001', 'live', NULL, NULL, now(), now()) ON CONFLICT (id) DO NOTHING;
INSERT INTO deployments (id, project_id, status, manifest, error_message, created_at, deployed_at) VALUES ('dpl_today2', 'proj_seed00000001', 'live', NULL, NULL, now(), now()) ON CONFLICT (id) DO NOTHING;

-- Custom domains
INSERT INTO domains (id, project_id, hostname, cf_hostname_id, status, created_at) VALUES ('dom_seed1', 'proj_seed00000001', 'myapp.example.com', 'cfhost_fake_001', 'active', now() - interval '14 days') ON CONFLICT (id) DO NOTHING;
INSERT INTO domains (id, project_id, hostname, cf_hostname_id, status, created_at) VALUES ('dom_seed2', 'proj_seed00000003', 'api.bobs-service.com', 'cfhost_fake_002', 'active', now() - interval '30 days') ON CONFLICT (id) DO NOTHING;
INSERT INTO domains (id, project_id, hostname, cf_hostname_id, status, created_at) VALUES ('dom_seed3', 'proj_seed00000005', 'app.carol.dev', 'cfhost_fake_003', 'pending', now() - interval '3 days') ON CONFLICT (id) DO NOTHING;

-- Resources
INSERT INTO resources (id, project_id, type, cf_id, binding_name, created_at) VALUES ('res_seed1', 'proj_seed00000001', 'd1', 'a1b2c3d4-0001-4000-8000-000000000001', 'DB', now() - interval '60 days') ON CONFLICT (id) DO NOTHING;
INSERT INTO resources (id, project_id, type, cf_id, binding_name, created_at) VALUES ('res_seed2', 'proj_seed00000001', 'kv', 'a1b2c3d4-0002-4000-8000-000000000002', 'CACHE', now() - interval '60 days') ON CONFLICT (id) DO NOTHING;
INSERT INTO resources (id, project_id, type, cf_id, binding_name, created_at) VALUES ('res_seed3', 'proj_seed00000003', 'd1', 'a1b2c3d4-0003-4000-8000-000000000003', 'DB', now() - interval '60 days') ON CONFLICT (id) DO NOTHING;
INSERT INTO resources (id, project_id, type, cf_id, binding_name, created_at) VALUES ('res_seed4', 'proj_seed00000003', 'r2', 'a1b2c3d4-0004-4000-8000-000000000004', 'UPLOADS', now() - interval '60 days') ON CONFLICT (id) DO NOTHING;
INSERT INTO resources (id, project_id, type, cf_id, binding_name, created_at) VALUES ('res_seed5', 'proj_seed00000005', 'd1', 'a1b2c3d4-0005-4000-8000-000000000005', 'DB', now() - interval '60 days') ON CONFLICT (id) DO NOTHING;
INSERT INTO resources (id, project_id, type, cf_id, binding_name, created_at) VALUES ('res_seed6', 'proj_seed00000005', 'kv', 'a1b2c3d4-0006-4000-8000-000000000006', 'SESSIONS', now() - interval '60 days') ON CONFLICT (id) DO NOTHING;
INSERT INTO resources (id, project_id, type, cf_id, binding_name, created_at) VALUES ('res_seed7', 'proj_seed00000005', 'r2', 'a1b2c3d4-0007-4000-8000-000000000007', 'ASSETS', now() - interval '60 days') ON CONFLICT (id) DO NOTHING;
