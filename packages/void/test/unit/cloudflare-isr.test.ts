import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { approvedCloudflareIsrBinding, chooseCloudflareIsr } from '../../src/cli/cloudflare-isr.ts';
import { renderVoidConfig } from '../../src/config-write.ts';
import { readConfig } from '../../src/config.ts';

const roots: Array<string> = [];
function project() {
  const root = mkdtempSync(join(tmpdir(), 'void-isr-choice-'));
  roots.push(root);
  writeFileSync(
    join(root, 'void.config.ts'),
    renderVoidConfig({
      head: { title: 'Blog' },
      routing: { headers: { '/posts/*.md': ['Content-Type: text/markdown'] } },
    }),
  );
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Cloudflare migration ISR choice', () => {
  it.each([true, false])('persists %s without changing other app settings', async (enabled) => {
    const root = project();
    const config = readConfig(root);
    const confirm = vi.fn().mockResolvedValue(enabled);
    expect(await chooseCloudflareIsr(root, config, { interactive: true, confirm })).toBe(enabled);
    expect(readConfig(root)).toEqual({
      head: { title: 'Blog' },
      routing: { isr: enabled, headers: { '/posts/*.md': ['Content-Type: text/markdown'] } },
    });
    expect(config.routing?.isr).toBe(enabled);
    expect(await chooseCloudflareIsr(root, readConfig(root), { interactive: false, confirm })).toBe(
      enabled,
    );
    expect(confirm).toHaveBeenCalledOnce();
  });
  it('does not save a choice or prompt in CI', async () => {
    const root = project();
    const before = readFileSync(join(root, 'void.config.ts'), 'utf8');
    const confirm = vi.fn();
    await expect(
      chooseCloudflareIsr(root, readConfig(root), { interactive: false, confirm }),
    ).rejects.toThrow('Set routing.isr to true');
    expect(confirm).not.toHaveBeenCalled();
    expect(readFileSync(join(root, 'void.config.ts'), 'utf8')).toBe(before);
  });
  it('authorizes only a valid configured cache and never an application KV alias', () => {
    const id = '0123456789abcdef0123456789abcdef';
    const rootConfig = { kv_namespaces: [{ binding: 'ISR_CACHE', id }] };
    expect(approvedCloudflareIsrBinding({ routing: { isr: true } }, rootConfig)).toEqual([
      { binding: 'ISR_CACHE', id },
    ]);
    expect(approvedCloudflareIsrBinding({}, rootConfig)).toEqual([]);
    expect(approvedCloudflareIsrBinding({ routing: { isr: false } }, rootConfig)).toEqual([]);
    expect(
      approvedCloudflareIsrBinding(
        { routing: { isr: true }, inference: { bindings: { kv: 'ISR_CACHE' } } },
        rootConfig,
      ),
    ).toEqual([]);
    expect(
      approvedCloudflareIsrBinding(
        { routing: { isr: true } },
        { kv_namespaces: [{ binding: 'ISR_CACHE', id: 'local' }] },
      ),
    ).toEqual([]);
  });
});
