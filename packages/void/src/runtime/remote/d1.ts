import type { ProxyClient } from './client';

/**
 * D1Database implementation backed by the remote proxy.
 * Used during local development when `remote: true` is set in void.json.
 */
export class ProxyD1Database {
  constructor(
    private client: ProxyClient,
    private binding: string,
  ) {}

  prepare(sql: string): ProxyD1PreparedStatement {
    return new ProxyD1PreparedStatement(this.client, this.binding, sql);
  }

  async batch<T = unknown>(stmts: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const statements = stmts.map((s) => ({
      sql: (s as any)._sql as string,
      params: (s as any)._params as unknown[],
    }));
    const res = await this.client.fetch('/d1/batch', {
      binding: this.binding,
      statements,
    });
    return (await res.json()) as D1Result<T>[];
  }

  async exec(sql: string): Promise<D1ExecResult> {
    const res = await this.client.fetch('/d1/query', {
      binding: this.binding,
      sql,
      method: 'run',
    });
    const data = (await res.json()) as { meta?: { changes?: number; duration?: number } };
    return {
      count: data.meta?.changes ?? 0,
      duration: data.meta?.duration ?? 0,
    };
  }

  dump(): Promise<ArrayBuffer> {
    throw new Error('dump() is not supported with remote bindings');
  }
}

/**
 * D1PreparedStatement implementation backed by the remote proxy.
 * Accumulates SQL and params synchronously; terminal methods (all, first, run, raw) make the HTTP call.
 */
export class ProxyD1PreparedStatement {
  /** @internal */
  _sql: string;
  /** @internal */
  _params: unknown[];

  constructor(
    private client: ProxyClient,
    private binding: string,
    sql: string,
  ) {
    this._sql = sql;
    this._params = [];
  }

  bind(...values: unknown[]): ProxyD1PreparedStatement {
    this._params = values;
    return this;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const res = await this.client.fetch('/d1/query', {
      binding: this.binding,
      sql: this._sql,
      params: this._params,
      method: 'all',
    });
    return (await res.json()) as D1Result<T>;
  }

  async first<T = Record<string, unknown>>(): Promise<T | null>;
  async first<T = unknown>(col: string): Promise<T | null>;
  async first<T = unknown>(col?: string): Promise<T | null> {
    const res = await this.client.fetch('/d1/query', {
      binding: this.binding,
      sql: this._sql,
      params: this._params,
      method: 'first',
    });
    const row = (await res.json()) as Record<string, unknown> | null;
    if (row === null) {
      return null;
    }
    if (col) {
      return row[col] as T;
    }
    return row as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const res = await this.client.fetch('/d1/query', {
      binding: this.binding,
      sql: this._sql,
      params: this._params,
      method: 'run',
    });
    return (await res.json()) as D1Result<T>;
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const res = await this.client.fetch('/d1/query', {
      binding: this.binding,
      sql: this._sql,
      params: this._params,
      method: 'raw',
    });
    const data = (await res.json()) as { columns: string[]; results: unknown[][] };
    if (options?.columnNames) {
      return [data.columns, ...data.results] as T[];
    }
    return data.results as T[];
  }
}
