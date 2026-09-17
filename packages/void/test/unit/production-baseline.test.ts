import { describe, expect, it, vi } from 'vite-plus/test';
import { productionBaseline } from '../../../../.github/scripts/production-baseline.ts';

describe('production compatibility baseline', () => {
  const old = 'a'.repeat(40);
  const candidate = 'b'.repeat(40);
  it('accepts an explicitly pinned revision without network access', async () => {
    const request = vi.fn();
    expect(await productionBaseline({ configuredSha: old, repository: '', request })).toBe(old);
    expect(request).not.toHaveBeenCalled();
  });
  it.each(['prod', 'v0.10.14', 'main', `${old}\n`])(
    'rejects mutable or malformed baseline %s',
    async (configuredSha) => {
      await expect(productionBaseline({ configuredSha, repository: '' })).rejects.toThrow(
        'immutable',
      );
    },
  );
  it('selects the successful deployment instead of a pending candidate', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json([
          { id: 2, environment: 'Prod', sha: candidate },
          { id: 1, environment: 'Prod', sha: old },
        ]),
      )
      .mockResolvedValueOnce(Response.json([{ state: 'pending' }]))
      .mockResolvedValueOnce(Response.json([{ state: 'success' }]));
    expect(await productionBaseline({ repository: 'owner/repo', token: 'test', request })).toBe(
      old,
    );
  });
  it('fails closed without a completed deployment or on a history read failure', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json([]));
    await expect(
      productionBaseline({ repository: 'owner/repo', token: 'test', request }),
    ).rejects.toThrow('No successful');
    request.mockResolvedValue(new Response(null, { status: 403 }));
    await expect(
      productionBaseline({ repository: 'owner/repo', token: 'test', request }),
    ).rejects.toThrow('(403)');
  });
});
