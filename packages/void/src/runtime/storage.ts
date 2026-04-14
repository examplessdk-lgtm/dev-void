/** Create a storage client for a specific R2Bucket instance. */
export function createStorage(bucket: R2Bucket): R2Bucket {
  return bucket;
}

import { requireRuntimeBinding } from './env';

/** Default storage client — resolves `STORAGE` from the active runtime environment. */
export const storage: R2Bucket = new Proxy({} as R2Bucket, {
  get(_target, prop) {
    const bucket = requireRuntimeBinding<R2Bucket>('STORAGE');
    const value = (bucket as any)[prop];
    return typeof value === 'function' ? value.bind(bucket) : value;
  },
});
