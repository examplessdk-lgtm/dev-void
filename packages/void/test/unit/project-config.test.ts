import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getApiUrl } from '../../src/cli/auth';
import {
  isVoidInternalStaging,
  readProjectConfig,
  writeProjectConfig,
} from '../../src/cli/project';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-project-config-'));
  roots.push(root);
  return root;
}

function writeProjectJson(root: string, value: unknown): void {
  const voidDir = join(root, '.void');
  mkdirSync(voidDir, { recursive: true });
  writeFileSync(join(voidDir, 'project.json'), JSON.stringify(value, null, 2) + '\n');
}

describe('project config', () => {
  afterEach(() => {
    delete process.env.VOID_API_URL;
    while (roots.length > 0) {
      rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  it('does not treat an internal staging-only file as a linked project', () => {
    const root = makeRoot();
    writeProjectJson(root, { voidInternalStaging: true });

    expect(readProjectConfig(root)).toBeNull();
    expect(isVoidInternalStaging(root)).toBe(true);
  });

  it('preserves the internal staging flag when linking a project', () => {
    const root = makeRoot();
    writeProjectJson(root, { voidInternalStaging: true });

    writeProjectConfig(root, { projectId: 'proj_123', slug: 'demo' });

    expect(readProjectConfig(root)).toEqual({
      projectId: 'proj_123',
      slug: 'demo',
      voidInternalStaging: true,
    });
    expect(JSON.parse(readFileSync(join(root, '.void', 'project.json'), 'utf-8'))).toEqual({
      projectId: 'proj_123',
      slug: 'demo',
      voidInternalStaging: true,
    });
  });

  it('uses the staging API from the internal project flag unless explicitly overridden', () => {
    const root = makeRoot();
    writeProjectJson(root, { voidInternalStaging: true });

    expect(getApiUrl(root)).toBe('https://api.staging.void.cloud');

    process.env.VOID_API_URL = 'https://api.example.test';
    expect(getApiUrl(root)).toBe('https://api.example.test');
  });
});
