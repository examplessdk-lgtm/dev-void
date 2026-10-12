import type { DeployEvent } from './types.ts';

export type DeploymentInput = {
  body: Record<string, unknown>;
  modules: Array<{ name: string; key: string; digest: string; type: string }>;
  credentialId?: string;
  oauthApproval?: string;
};
export type DeploymentProgress = { seq: number; event: DeployEvent };
export type DeploymentOperation = {
  id: string;
  project_id: string;
  actor_id: string;
  build_id: string | null;
  original_active_id: string | null;
  cli_version: string | null;
  idempotency_key: string;
  input_digest: string;
  input_prefix: string;
  payload: DeploymentInput;
  status: 'queued' | 'running' | 'recovering' | 'terminal';
  owner_id: string | null;
  lease_expires_at: string | null;
  next_dispatch_at: string;
  events: Array<DeploymentProgress>;
  last_seq: number;
  inputs_deleted: boolean;
  created_at: string;
};
