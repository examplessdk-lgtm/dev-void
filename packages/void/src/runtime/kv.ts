export interface PutOptions {
  ttl?: number;
  expiration?: number;
  metadata?: Record<string, unknown>;
}

export interface ListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

export interface ListKey<M = unknown> {
  name: string;
  expiration?: number;
  metadata?: M;
}

export interface ListResult<M = unknown> {
  keys: ListKey<M>[];
  list_complete: boolean;
  cursor?: string;
}

export interface KVMap<T> {
  get(key: string): Promise<T | null>;
  put(key: string, value: T, options?: PutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  list<M = unknown>(options?: Omit<ListOptions, 'prefix'>): Promise<ListResult<M>>;
  getWithMetadata<M = unknown>(key: string): Promise<{ value: T | null; metadata: M | null }>;
}

export interface KVClient {
  get<T = string>(key: string): Promise<T | null>;
  put(key: string, value: unknown, options?: PutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  list<M = unknown>(options?: ListOptions): Promise<ListResult<M>>;
  getWithMetadata<T = string, M = unknown>(
    key: string,
  ): Promise<{ value: T | null; metadata: M | null }>;
  map<T = unknown>(prefix: string): KVMap<T>;
}

function parseValue<T>(raw: string | null): T | null {
  if (raw === null) {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return raw as T;
  }
}

function serializeValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

function getListCursor<M>(
  result: KVNamespaceListResult<M> & Partial<{ cursor: string }>,
): string | undefined {
  return typeof result.cursor === 'string' ? result.cursor : undefined;
}

function createKVMap<T>(getNS: () => KVNamespace, prefix: string): KVMap<T> {
  const prefixed = (key: string) => `${prefix}:${key}`;

  return {
    async get(key) {
      const raw = await getNS().get(prefixed(key));
      return parseValue<T>(raw);
    },

    async put(key, value, options) {
      const opts: KVNamespacePutOptions = {};
      if (options?.ttl) {
        opts.expirationTtl = options.ttl;
      }
      if (options?.expiration) {
        opts.expiration = options.expiration;
      }
      if (options?.metadata) {
        opts.metadata = options.metadata;
      }
      await getNS().put(prefixed(key), serializeValue(value), opts);
    },

    async delete(key) {
      await getNS().delete(prefixed(key));
    },

    async list<M = unknown>(options?: Omit<ListOptions, 'prefix'>): Promise<ListResult<M>> {
      const result = await getNS().list({
        prefix: `${prefix}:`,
        limit: options?.limit,
        cursor: options?.cursor,
      });
      const stripLen = prefix.length + 1;
      return {
        keys: result.keys.map((k) => ({
          ...k,
          name: k.name.slice(stripLen),
        })) as ListKey<M>[],
        list_complete: result.list_complete,
        cursor: getListCursor(result),
      };
    },

    async getWithMetadata<M = unknown>(key: string) {
      const result = await getNS().getWithMetadata(prefixed(key));
      const metadata = result.metadata as M | null;
      return {
        value: parseValue<T>(result.value),
        metadata,
      };
    },
  };
}

function createKVClient(getNS: () => KVNamespace): KVClient {
  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      const raw = await getNS().get(key);
      return parseValue<T>(raw);
    },

    async put(key, value, options) {
      const opts: KVNamespacePutOptions = {};
      if (options?.ttl) {
        opts.expirationTtl = options.ttl;
      }
      if (options?.expiration) {
        opts.expiration = options.expiration;
      }
      if (options?.metadata) {
        opts.metadata = options.metadata;
      }
      await getNS().put(key, serializeValue(value), opts);
    },

    async delete(key) {
      await getNS().delete(key);
    },

    async list<M = unknown>(options?: ListOptions): Promise<ListResult<M>> {
      const result = await getNS().list({
        prefix: options?.prefix,
        limit: options?.limit,
        cursor: options?.cursor,
      });
      return {
        keys: result.keys as ListKey<M>[],
        list_complete: result.list_complete,
        cursor: getListCursor(result),
      };
    },

    async getWithMetadata<T = unknown, M = unknown>(key: string) {
      const result = await getNS().getWithMetadata(key);
      return {
        value: parseValue<T>(result.value),
        metadata: result.metadata as M | null,
      };
    },

    map<T = unknown>(prefix: string) {
      return createKVMap<T>(getNS, prefix);
    },
  };
}

/** Create a KV client for a specific KVNamespace instance. */
export function createKV(namespace: KVNamespace): KVClient {
  return createKVClient(() => namespace);
}

import { requireRuntimeBinding } from './env';

/** Default KV client — resolves `KV` from the active runtime environment. */
export const kv: KVClient = createKVClient(() => requireRuntimeBinding<KVNamespace>('KV'));
