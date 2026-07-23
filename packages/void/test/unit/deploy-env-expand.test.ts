import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { loadDeployEnv } from '../../src/cli/deploy.ts';

describe('loadDeployEnv', () => {
  const roots: Array<string> = [];

  afterEach(() => {
    for (const root of roots.splice(0, roots.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function makeRoot(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'void-deploy-env-'));
    roots.push(root);
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(root, name), content);
    }
    return root;
  }

  it('expands ${VAR} references so shipped values match what was validated', () => {
    const root = makeRoot({
      '.env': 'PLAIN=hello\nAPI_HOST=api.example.com\nAPI_URL=https://${API_HOST}/v1\n',
    });

    const env = loadDeployEnv(root);

    expect(env.PLAIN).toBe('hello');
    expect(env.API_HOST).toBe('api.example.com');
    expect(env.API_URL).toBe('https://api.example.com/v1');
  });

  it('expands references across .env and .env.production', () => {
    const root = makeRoot({
      '.env': 'BASE=example.com\n',
      '.env.production': 'URL=https://${BASE}/prod\n',
    });

    expect(loadDeployEnv(root).URL).toBe('https://example.com/prod');
  });
});
