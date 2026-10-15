export type DatabaseProviderDialect = 'postgresql' | 'mysql';

export type DatabaseProvisionOptions = {
  name: string;
  dialect: DatabaseProviderDialect;
  region?: string;
  signal?: AbortSignal;
};

export type DatabaseProvisionResult = {
  /** Connection string that `void db connect` saves as `DATABASE_URL`. */
  connectionString: string;
  /**
   * @deprecated Void does not read this field. Put a provider console link in
   * `dashboardUrl` instead. Removed in the next major version.
   */
  projectId?: string;
  /** Provider console URL that `void db connect` prints after provisioning. */
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
