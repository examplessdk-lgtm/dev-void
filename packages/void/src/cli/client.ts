import { getApiUrl } from './auth';
import type { DeployEvent } from './types';

type PlatformErrorPayload = {
  error?: string;
  message?: string;
};

function parsePlatformErrorBody(body: string): PlatformErrorPayload | null {
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed as PlatformErrorPayload;
  } catch {
    return null;
  }
}

export class PlatformApiError extends Error {
  status: number;
  body: string;
  code?: string;

  constructor(action: string, status: number, body: string) {
    super(`${action}: ${status} ${body}`);
    this.name = 'PlatformApiError';
    this.status = status;
    this.body = body;
    const parsed = parsePlatformErrorBody(body);
    this.code = parsed?.error ?? parsed?.message;
  }
}

async function throwPlatformApiError(action: string, res: Response): Promise<never> {
  throw new PlatformApiError(action, res.status, await res.text());
}

export function isExpiredTokenError(error: unknown): boolean {
  if (error instanceof PlatformApiError) {
    return error.status === 401 && error.code === 'invalid or expired token';
  }
  return false;
}

export interface ProjectResponse {
  id: string;
  user_id: string;
  slug: string;
  type: string;
  created_at: string;
  custom_domain: string | null;
}

export interface CreateProjectResponse {
  id: string;
  slug: string;
}

export interface DeleteProjectResponse {
  ok: boolean;
  id: string;
  slug: string;
  warnings?: string[];
}

export interface DeploymentResponse {
  id: string;
  status: string;
  source: string | null;
  commit: string | null;
  manifest: string | null;
  error_message: string | null;
  retained: boolean;
  applied_migrations: string | null;
  created_at: string;
  deployed_at: string | null;
}

export interface DeploymentListResponse {
  deployments: DeploymentResponse[];
  activeDeploymentId: string | null;
}

export interface SecretResponse {
  ok: boolean;
  name: string;
}

export interface LogEntry {
  timestamp: number;
  outcome: string;
  logs: { level: string; message: unknown[]; timestamp: number }[];
  exceptions: { name: string; message: string; timestamp: number }[];
  url: string;
  method: string;
  status: string;
}

export interface DomainResponse {
  id: string;
  project_id: string;
  hostname: string;
  cf_hostname_id: string;
  status: string;
  created_at: string;
  cname_target?: string;
}

export interface DomainStatusResponse extends DomainResponse {
  ssl_status: string;
  verification_errors?: string[];
}

/**
 * HTTP client for the Void platform API.
 */
export class PlatformClient {
  private baseUrl: string;
  private token: string;

  constructor(token: string, options?: string | { apiUrl?: string; root?: string }) {
    this.token = token;
    if (typeof options === 'string') {
      this.baseUrl = options;
    } else {
      this.baseUrl = options?.apiUrl ?? getApiUrl(options?.root);
    }
  }

  async whoami(): Promise<{ login: string; plan: string }> {
    const res = await fetch(`${this.baseUrl}/me`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to fetch user info', res);
    }

    return res.json();
  }

  async listProjects(): Promise<ProjectResponse[]> {
    const res = await fetch(`${this.baseUrl}/projects`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to list projects', res);
    }

    return res.json();
  }

  async listDeployments(projectId: string): Promise<DeploymentListResponse> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/deployments`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to list deployments', res);
    }

    return res.json();
  }

  async rollback(
    projectId: string,
    deploymentId: string,
  ): Promise<{ ok: boolean; deploymentId?: string; migrationDiff?: string[]; error?: string }> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/rollback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ deploymentId }),
    });

    if (!res.ok) {
      await throwPlatformApiError('Rollback failed', res);
    }

    return res.json();
  }

  async cancelDeployment(
    projectId: string,
    deploymentId: string,
  ): Promise<{ ok: boolean; deploymentId: string; status: string }> {
    const res = await fetch(
      `${this.baseUrl}/projects/${projectId}/deployments/${deploymentId}/cancel`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      },
    );

    if (!res.ok) {
      await throwPlatformApiError('Cancel deployment failed', res);
    }

    return res.json();
  }

  async createProject(slug: string): Promise<CreateProjectResponse> {
    const res = await fetch(`${this.baseUrl}/projects`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ slug }),
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to create project', res);
    }

    return res.json();
  }

  async preflight(
    projectId: string,
    assetManifest: Record<string, { hash: string; size: number }>,
    hasWorker?: boolean,
  ): Promise<{ needed: string[]; total: number; skipped: number }> {
    const total = Object.keys(assetManifest).length;
    try {
      const res = await fetch(`${this.baseUrl}/projects/${projectId}/deploy/preflight`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ assetManifest, ...(hasWorker && { hasWorker }) }),
      });

      if (!res.ok) {
        const error = new PlatformApiError('Preflight failed', res.status, await res.text());
        if (isExpiredTokenError(error)) {
          throw error;
        }
        // Preflight not supported or error — fall back to uploading everything
        return { needed: Object.keys(assetManifest), total, skipped: 0 };
      }

      return res.json();
    } catch (error) {
      if (isExpiredTokenError(error)) {
        throw error;
      }
      // Network error — fall back to uploading everything
      return { needed: Object.keys(assetManifest), total, skipped: 0 };
    }
  }

  async *deploy(projectId: string, formData: FormData): AsyncGenerator<DeployEvent> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/deploy`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
      body: formData,
    });

    if (!res.ok) {
      await throwPlatformApiError('Deploy failed', res);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        if (line.trim()) {
          yield JSON.parse(line) as DeployEvent;
        }
      }
    }
  }

  async listSecrets(projectId: string): Promise<{ name: string }[]> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/secrets`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to list secrets', res);
    }

    return res.json();
  }

  async setSecret(projectId: string, name: string, value: string): Promise<SecretResponse> {
    const res = await fetch(
      `${this.baseUrl}/projects/${projectId}/secrets/${encodeURIComponent(name)}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ value }),
      },
    );

    if (!res.ok) {
      await throwPlatformApiError('Failed to set secret', res);
    }

    return res.json();
  }

  async deleteProject(projectId: string): Promise<DeleteProjectResponse> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to delete project', res);
    }

    return res.json();
  }

  async getMigrationStatus(
    projectId: string,
  ): Promise<{ applied: { name: string; applied_at: string }[] }> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/migrations`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to get migration status', res);
    }

    return res.json();
  }

  async applyRemoteMigrations(
    projectId: string,
    migrations: { name: string; sql: string }[],
  ): Promise<{ ok: boolean; applied: string[]; skipped: string[]; error?: string }> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/migrations/apply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ migrations }),
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to apply remote migrations', res);
    }

    return res.json();
  }

  async renameMigrations(
    projectId: string,
    renames: { from: string; to: string }[],
  ): Promise<{ ok: boolean }> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/migrations/rename`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ renames }),
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to rename remote migrations', res);
    }

    return res.json();
  }

  async addDomain(projectId: string, hostname: string): Promise<DomainResponse> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/domains`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ hostname }),
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to add domain', res);
    }

    return res.json();
  }

  async listDomains(projectId: string): Promise<DomainResponse[]> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/domains`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to list domains', res);
    }

    return res.json();
  }

  async getDomainStatus(projectId: string, domainId: string): Promise<DomainStatusResponse> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/domains/${domainId}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to get domain status', res);
    }

    return res.json();
  }

  async removeDomain(projectId: string, domainId: string): Promise<{ ok: boolean }> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/domains/${domainId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to remove domain', res);
    }

    return res.json();
  }

  async deleteSecret(projectId: string, name: string): Promise<SecretResponse> {
    const res = await fetch(
      `${this.baseUrl}/projects/${projectId}/secrets/${encodeURIComponent(name)}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      },
    );

    if (!res.ok) {
      await throwPlatformApiError('Failed to delete secret', res);
    }

    return res.json();
  }

  async getResources(projectId: string): Promise<{ type: string; binding_name: string }[]> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/resources`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to get resources', res);
    }

    return res.json();
  }

  async provisionDatabase(projectId: string, connectionString: string): Promise<{ ok: boolean }> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/database`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ connectionString }),
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to provision database', res);
    }

    return res.json();
  }

  async setDatabaseUrl(projectId: string, connectionString: string): Promise<{ ok: boolean }> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/database-url`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ connectionString }),
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to update database URL', res);
    }

    return res.json();
  }

  async purgeCache(projectId: string): Promise<{ purged: number }> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/revalidate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ all: true }),
    });

    if (!res.ok) {
      await throwPlatformApiError('Cache purge failed', res);
    }

    return res.json();
  }

  async getLogs(
    projectId: string,
    since: string,
    limit = 200,
    deploymentId?: string,
  ): Promise<LogEntry[]> {
    const params = new URLSearchParams({
      since,
      limit: String(limit),
    });
    if (deploymentId) {
      params.set('deploymentId', deploymentId);
    }

    const res = await fetch(`${this.baseUrl}/projects/${projectId}/logs?${params}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to fetch logs', res);
    }

    const json = (await res.json()) as { data: LogEntry[] };
    return json.data;
  }
}
