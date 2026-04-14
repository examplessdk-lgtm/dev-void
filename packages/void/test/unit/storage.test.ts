import { describe, it, expect, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

import { createStorage } from '../../src/runtime/storage';

function createMockR2Bucket() {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
    head: vi.fn().mockResolvedValue(null),
  } as unknown as R2Bucket & {
    get: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
}

describe('createStorage', () => {
  it('returns the bucket directly', () => {
    const mockBucket = createMockR2Bucket();
    const s = createStorage(mockBucket);
    expect(s).toBe(mockBucket);
  });

  it('get passes through to bucket', async () => {
    const mockBucket = createMockR2Bucket();
    const mockBody = { key: 'file.txt', body: 'content' };
    mockBucket.get.mockResolvedValue(mockBody);
    const s = createStorage(mockBucket);
    const result = await s.get('file.txt');
    expect(mockBucket.get).toHaveBeenCalledWith('file.txt');
    expect(result).toBe(mockBody);
  });

  it('put passes through to bucket', async () => {
    const mockBucket = createMockR2Bucket();
    const s = createStorage(mockBucket);
    await s.put('file.txt', 'content', { httpMetadata: { contentType: 'text/plain' } });
    expect(mockBucket.put).toHaveBeenCalledWith('file.txt', 'content', {
      httpMetadata: { contentType: 'text/plain' },
    });
  });

  it('delete passes through to bucket', async () => {
    const mockBucket = createMockR2Bucket();
    const s = createStorage(mockBucket);
    await s.delete('file.txt');
    expect(mockBucket.delete).toHaveBeenCalledWith('file.txt');
  });
});
