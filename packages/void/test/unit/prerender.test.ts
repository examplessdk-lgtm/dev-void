import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'pathe';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { buildPrerenderBindings, collectPrerenderWorkerModules } from '../../src/prerender.ts';
import { INTERNAL_ENV_KEYS, stripInternalEnvKeys } from '../../src/shared/env.ts';

const tempDirs: Array<string> = [];

function createTempWorkerDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'void-prerender-'));
  tempDirs.push(dir);
  return dir;
}

describe('stripInternalEnvKeys', () => {
  it('returns empty sanitized + empty stripped for undefined input', () => {
    const result = stripInternalEnvKeys(undefined);
    expect(result.sanitized).toEqual({});
    expect(result.stripped).toEqual([]);
  });

  it('returns empty sanitized + empty stripped for empty object', () => {
    const result = stripInternalEnvKeys({});
    expect(result.sanitized).toEqual({});
    expect(result.stripped).toEqual([]);
  });

  it('passes through non-internal keys unchanged', () => {
    const result = stripInternalEnvKeys({ API_URL: 'https://api', FOO: 'bar' });
    expect(result.sanitized).toEqual({ API_URL: 'https://api', FOO: 'bar' });
    expect(result.stripped).toEqual([]);
  });

  it('strips every internal key listed in INTERNAL_ENV_KEYS', () => {
    const polluted: Record<string, string> = { SAFE: 'keep' };
    for (const key of INTERNAL_ENV_KEYS) {
      polluted[key] = 'polluted';
    }
    const result = stripInternalEnvKeys(polluted);
    expect(result.sanitized).toEqual({ SAFE: 'keep' });
    expect(result.stripped.sort()).toEqual([...INTERNAL_ENV_KEYS].sort());
  });

  it('preserves non-internal keys when mixed with internal keys', () => {
    const result = stripInternalEnvKeys({
      __VOID_TOKEN: 'polluted',
      API_URL: 'https://api',
      __VOID_REMOTE: '1',
      FOO: 'bar',
    });
    expect(result.sanitized).toEqual({ API_URL: 'https://api', FOO: 'bar' });
    expect(result.stripped.sort()).toEqual(['__VOID_REMOTE', '__VOID_TOKEN']);
  });
});

describe('collectPrerenderWorkerModules', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('collects supported modules and keeps the entry first', () => {
    const workerDir = createTempWorkerDir();

    mkdirSync(join(workerDir, '.vite'), { recursive: true });
    mkdirSync(join(workerDir, 'assets'), { recursive: true });

    writeFileSync(join(workerDir, 'wrangler.json'), '{}');
    writeFileSync(join(workerDir, '.vite', 'manifest.json'), '{}');
    writeFileSync(join(workerDir, 'index.js'), 'export default {};');
    writeFileSync(join(workerDir, 'pages-client.js'), 'export const client = true;');
    writeFileSync(join(workerDir, 'assets', 'chunk.js'), 'export const chunk = true;');
    writeFileSync(join(workerDir, 'assets', 'legacy.cjs'), 'module.exports = {};');
    writeFileSync(join(workerDir, 'assets', 'module.wasm'), 'wasm');
    writeFileSync(join(workerDir, 'assets', 'message.txt'), 'hello');
    writeFileSync(join(workerDir, 'assets', 'blob.bin'), 'data');

    const modules = collectPrerenderWorkerModules(workerDir, 'index.js');

    expect(
      modules.map(({ path, type }) => ({
        path: relative(workerDir, path).replace(/\\/g, '/'),
        type,
      })),
    ).toEqual([
      { path: 'index.js', type: 'ESModule' },
      { path: 'assets/blob.bin', type: 'Data' },
      { path: 'assets/chunk.js', type: 'ESModule' },
      { path: 'assets/legacy.cjs', type: 'CommonJS' },
      { path: 'assets/message.txt', type: 'Text' },
      { path: 'assets/module.wasm', type: 'CompiledWasm' },
      { path: 'pages-client.js', type: 'ESModule' },
    ]);
  });

  it('throws when the configured worker entry is missing', () => {
    const workerDir = createTempWorkerDir();
    writeFileSync(join(workerDir, 'pages-client.js'), 'export const client = true;');

    expect(() => collectPrerenderWorkerModules(workerDir, 'index.js')).toThrow(
      "Worker entry 'index.js' not found",
    );
  });
});

describe('buildPrerenderBindings', () => {
  it('omits __VOID_* bindings when the token is missing', () => {
    const result = buildPrerenderBindings({
      wranglerVars: {},
      env: {},
      voidToken: null,
      voidProjectId: undefined,
      voidStaging: false,
      remoteMode: false,
    });

    expect(result).toStrictEqual({});
    expect(Object.keys(result).some((key) => key.startsWith('__VOID_'))).toBe(false);
  });

  it('omits __VOID_* bindings when the projectId is missing', () => {
    const result = buildPrerenderBindings({
      wranglerVars: {},
      env: {},
      voidToken: 'tkn',
      voidProjectId: undefined,
      voidStaging: false,
      remoteMode: false,
    });

    expect(result).toStrictEqual({});
    expect(Object.keys(result).some((key) => key.startsWith('__VOID_'))).toBe(false);
  });

  it('omits __VOID_* bindings when both token and projectId are missing', () => {
    const result = buildPrerenderBindings({
      wranglerVars: {},
      env: {},
      voidToken: null,
      voidProjectId: undefined,
      voidStaging: false,
      remoteMode: false,
    });

    expect(result).toStrictEqual({});
    expect(Object.keys(result).some((key) => key.startsWith('__VOID_'))).toBe(false);
  });

  it('sets credentials and production proxy URL when token+projectId are present', () => {
    const result = buildPrerenderBindings({
      wranglerVars: {},
      env: {},
      voidToken: 'tkn',
      voidProjectId: 'proj',
      voidStaging: false,
      remoteMode: false,
    });

    expect(result.__VOID_TOKEN).toBe('tkn');
    expect(result.__VOID_PROJECT_ID).toBe('proj');
    expect(result.__VOID_PROXY_URL).toBe('https://proxy.void.cloud');
    expect(result).not.toHaveProperty('__VOID_STAGING');
    expect(result).not.toHaveProperty('__VOID_REMOTE');
  });

  it('flips the proxy URL and sets __VOID_STAGING in staging mode', () => {
    const result = buildPrerenderBindings({
      wranglerVars: {},
      env: {},
      voidToken: 'tkn',
      voidProjectId: 'proj',
      voidStaging: true,
      remoteMode: false,
    });

    expect(result.__VOID_STAGING).toBe('1');
    expect(result.__VOID_PROXY_URL).toBe('https://proxy.staging.void.cloud');
  });

  it('sets __VOID_REMOTE when remote mode is enabled', () => {
    const result = buildPrerenderBindings({
      wranglerVars: {},
      env: {},
      voidToken: 'tkn',
      voidProjectId: 'proj',
      voidStaging: false,
      remoteMode: true,
    });

    expect(result.__VOID_REMOTE).toBe('1');
  });

  it('does not set __VOID_REMOTE when credentials are missing', () => {
    const result = buildPrerenderBindings({
      wranglerVars: {},
      env: {},
      voidToken: null,
      voidProjectId: undefined,
      voidStaging: false,
      remoteMode: true,
    });

    expect(result).not.toHaveProperty('__VOID_REMOTE');
    expect(Object.keys(result).some((key) => key.startsWith('__VOID_'))).toBe(false);
  });

  it('passes user wranglerVars through to the final bindings record', () => {
    const result = buildPrerenderBindings({
      wranglerVars: { API_URL: 'https://api.example.com' },
      env: {},
      voidToken: null,
      voidProjectId: undefined,
      voidStaging: false,
      remoteMode: false,
    });

    expect(result.API_URL).toBe('https://api.example.com');
  });

  it('passes filtered dotenv vars through to the final bindings record', () => {
    const result = buildPrerenderBindings({
      wranglerVars: {},
      env: { FOO: 'bar' },
      voidToken: null,
      voidProjectId: undefined,
      voidStaging: false,
      remoteMode: false,
    });

    expect(result.FOO).toBe('bar');
  });

  it('overrides user wranglerVars with __VOID_* bindings of the same name', () => {
    const result = buildPrerenderBindings({
      wranglerVars: { __VOID_TOKEN: 'USER_SET_WRONG' },
      env: {},
      voidToken: 'real',
      voidProjectId: 'proj',
      voidStaging: false,
      remoteMode: false,
    });

    expect(result.__VOID_TOKEN).toBe('real');
  });

  it('strips __VOID_TOKEN from wranglerVars when credentials are absent', () => {
    const result = buildPrerenderBindings({
      wranglerVars: { __VOID_TOKEN: 'polluted-token', API_URL: 'https://api.example.com' },
      env: {},
      voidToken: null,
      voidProjectId: undefined,
      voidStaging: false,
      remoteMode: false,
    });

    expect(result).not.toHaveProperty('__VOID_TOKEN');
    expect(result.API_URL).toBe('https://api.example.com');
  });

  it('strips __VOID_REMOTE from env when credentials are absent', () => {
    const result = buildPrerenderBindings({
      wranglerVars: {},
      env: { __VOID_REMOTE: '1', FOO: 'bar' },
      voidToken: null,
      voidProjectId: undefined,
      voidStaging: false,
      remoteMode: false,
    });

    expect(result).not.toHaveProperty('__VOID_REMOTE');
    expect(result.FOO).toBe('bar');
  });

  it('strips __VOID_PROJECT_ID from wranglerVars when credentials are absent', () => {
    const result = buildPrerenderBindings({
      wranglerVars: { __VOID_PROJECT_ID: 'polluted-project' },
      env: {},
      voidToken: null,
      voidProjectId: undefined,
      voidStaging: false,
      remoteMode: false,
    });

    expect(result).not.toHaveProperty('__VOID_PROJECT_ID');
  });

  it('strips polluted __VOID_* from both wranglerVars and env simultaneously', () => {
    const result = buildPrerenderBindings({
      wranglerVars: { __VOID_TOKEN: 'wv-poll', API_URL: 'https://api.example.com' },
      env: { __VOID_REMOTE: '1', __VOID_STAGING: '1', FOO: 'bar' },
      voidToken: null,
      voidProjectId: undefined,
      voidStaging: false,
      remoteMode: false,
    });

    expect(result).not.toHaveProperty('__VOID_TOKEN');
    expect(result).not.toHaveProperty('__VOID_REMOTE');
    expect(result).not.toHaveProperty('__VOID_STAGING');
    expect(result.API_URL).toBe('https://api.example.com');
    expect(result.FOO).toBe('bar');
  });

  it('still strips polluted __VOID_* even when real credentials are present', () => {
    const result = buildPrerenderBindings({
      wranglerVars: { __VOID_TOKEN: 'wv-poll', __VOID_PROXY_TOKEN: 'poll' },
      env: { __VOID_PROXY_URL: 'https://evil.example.com' },
      voidToken: 'real',
      voidProjectId: 'proj',
      voidStaging: false,
      remoteMode: false,
    });

    expect(result.__VOID_TOKEN).toBe('real');
    expect(result.__VOID_PROJECT_ID).toBe('proj');
    expect(result.__VOID_PROXY_URL).toBe('https://proxy.void.cloud');
    expect(result).not.toHaveProperty('__VOID_PROXY_TOKEN');
  });
});
