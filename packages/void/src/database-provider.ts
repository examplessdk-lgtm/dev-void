export type DatabaseProviderDialect = 'postgresql' | 'mysql';

export type DatabaseProvisionOptions = {
  name: string;
  dialect: DatabaseProviderDialect;
  region?: string;
  signal?: AbortSignal;
};

export type DatabaseProvisionResult = {
  connectionString: string;
  projectId?: string;
  dashboardUrl?: string;
};

export type DatabaseProviderAdapter = {
  id: string;
  label: string;
  dialects: ReadonlyArray<DatabaseProviderDialect>;
  provision(options: DatabaseProvisionOptions): Promise<DatabaseProvisionResult>;
};

export function defineDatabaseProvider(adapter: DatabaseProviderAdapter): DatabaseProviderAdapter {
  return adapter;
}
