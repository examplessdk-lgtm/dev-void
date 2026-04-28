import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/log', () => ({
  voidLog: vi.fn(),
  voidWarn: vi.fn(),
  voidError: vi.fn(),
}));

import {
  readConfig,
  convertHeadersConfig,
  convertFallbacksConfig,
  convertRedirectsConfig,
  convertRewritesConfig,
  resolveBindingNames,
  isNodeTarget,
  getDatabaseDialect,
  VALID_REDIRECT_STATUSES,
} from '../../src/config';
import { voidWarn } from '../../src/log';
import { resolveSandboxConfig } from '../../src/sandbox/config';

const warnMock = vi.mocked(voidWarn);

const tmpDir = join(import.meta.dirname, '.tmp-config-test');

function setup(content?: string) {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  if (content !== undefined) {
    writeFileSync(join(tmpDir, 'void.json'), content);
  }
}

function cleanup() {
  rmSync(tmpDir, { recursive: true, force: true });
}

describe('readConfig', () => {
  it('returns empty config when no file exists', () => {
    setup();
    const config = readConfig(tmpDir);
    expect(config).toEqual({});
    cleanup();
  });

  it('reads a valid config with all fields', () => {
    setup(
      JSON.stringify({
        inference: {
          bindings: { db: true, kv: false },
          appType: 'spa',
          outputDir: 'dist',
        },
        routing: {
          headers: {
            '/assets/*': ['Cache-Control: public, max-age=31536000, immutable'],
            '/*': ['X-Frame-Options: DENY'],
          },
        },
        worker: {
          compatibility_date: '2025-12-01',
          compatibility_flags: ['nodejs_compat'],
        },
        sandbox: {
          binding: 'CODE',
          image: './Dockerfile.sandbox',
          instanceType: 'lite',
          maxInstances: 2,
        },
      }),
    );
    const config = readConfig(tmpDir);
    expect(config.inference?.bindings).toEqual({ db: true, kv: false });
    expect(config.routing?.headers).toEqual({
      '/assets/*': ['Cache-Control: public, max-age=31536000, immutable'],
      '/*': ['X-Frame-Options: DENY'],
    });
    expect(config.inference?.appType).toBe('spa');
    expect(config.inference?.outputDir).toBe('dist');
    expect(config.worker).toEqual({
      compatibility_date: '2025-12-01',
      compatibility_flags: ['nodejs_compat'],
    });
    expect(config.sandbox).toEqual({
      binding: 'CODE',
      image: './Dockerfile.sandbox',
      instanceType: 'lite',
      maxInstances: 2,
    });
    cleanup();
  });

  it('accepts empty object', () => {
    setup('{}');
    const config = readConfig(tmpDir);
    expect(config).toEqual({});
    cleanup();
  });

  it('accepts top-level auth providers', () => {
    setup(JSON.stringify({ auth: { providers: ['email', 'github', 'discord'] } }));
    const config = readConfig(tmpDir);
    expect(config.auth?.providers).toEqual(['email', 'github', 'discord']);
    cleanup();
  });

  it('accepts an empty top-level auth object', () => {
    setup(JSON.stringify({ auth: {} }));
    const config = readConfig(tmpDir);
    expect(config.auth).toEqual({});
    cleanup();
  });

  it('ignores $schema field', () => {
    setup(JSON.stringify({ $schema: 'https://unpkg.com/void/schema.json' }));
    const config = readConfig(tmpDir);
    expect(config.$schema).toBe('https://unpkg.com/void/schema.json');
    cleanup();
  });

  it('throws on invalid JSON', () => {
    setup('{not json}');
    expect(() => readConfig(tmpDir)).toThrow('Invalid JSON');
    cleanup();
  });

  it('throws if root is not an object', () => {
    setup('"hello"');
    expect(() => readConfig(tmpDir)).toThrow('must be a JSON object');
    cleanup();
  });

  it('rejects inference.auth arrays', () => {
    setup(JSON.stringify({ inference: { auth: ['github', 'twitter'] } }));
    expect(() => readConfig(tmpDir)).toThrow(
      '"inference.auth" in void.json is no longer supported',
    );
    cleanup();
  });

  it('rejects inference.auth regardless of type', () => {
    setup(JSON.stringify({ inference: { auth: 'github' } }));
    expect(() => readConfig(tmpDir)).toThrow(
      '"inference.auth" in void.json is no longer supported',
    );
    cleanup();
  });

  it('rejects unknown top-level auth providers', () => {
    setup(JSON.stringify({ auth: { providers: ['email', 'patreon'] } }));
    expect(() => readConfig(tmpDir)).toThrow('"auth.providers" value \'patreon\'');
    cleanup();
  });

  it('rejects duplicate top-level auth providers', () => {
    setup(JSON.stringify({ auth: { providers: ['github', 'github'] } }));
    expect(() => readConfig(tmpDir)).toThrow(
      '"auth.providers" in void.json must not contain duplicates',
    );
    cleanup();
  });

  it('throws on invalid bindings type', () => {
    setup(JSON.stringify({ inference: { bindings: 'db' } }));
    expect(() => readConfig(tmpDir)).toThrow('"inference.bindings"');
    cleanup();
  });

  it('throws on unknown binding key', () => {
    setup(JSON.stringify({ inference: { bindings: { db: true, queue: true } } }));
    expect(() => readConfig(tmpDir)).toThrow("Unknown binding 'queue'");
    cleanup();
  });

  it('accepts string binding names for db/kv/storage', () => {
    setup(
      JSON.stringify({
        inference: { bindings: { db: 'MY_DB', kv: 'MY_KV', storage: 'MY_R2' } },
      }),
    );
    const config = readConfig(tmpDir);
    expect(config.inference?.bindings?.db).toBe('MY_DB');
    expect(config.inference?.bindings?.kv).toBe('MY_KV');
    expect(config.inference?.bindings?.storage).toBe('MY_R2');
    cleanup();
  });

  it('throws on non-boolean ai binding value', () => {
    setup(JSON.stringify({ inference: { bindings: { ai: 'yes' } } }));
    expect(() => readConfig(tmpDir)).toThrow('must be a boolean');
    cleanup();
  });

  it('throws on invalid binding value type', () => {
    setup(JSON.stringify({ inference: { bindings: { db: 42 } } }));
    expect(() => readConfig(tmpDir)).toThrow('must be a boolean or a string');
    cleanup();
  });

  it('accepts sandbox boolean and object config', () => {
    setup(JSON.stringify({ sandbox: true }));
    expect(readConfig(tmpDir).sandbox).toBe(true);
    cleanup();

    setup(
      JSON.stringify({
        sandbox: {
          binding: 'CODE',
          className: 'CodeSandbox',
          containerName: 'code-sandbox',
          image: './Dockerfile.sandbox',
          imageBuildContext: '.',
          platformImage: 'registry.example.com/code-sandbox:latest',
          instanceType: 'basic',
          maxInstances: 3,
        },
      }),
    );
    expect(readConfig(tmpDir).sandbox).toEqual({
      binding: 'CODE',
      className: 'CodeSandbox',
      containerName: 'code-sandbox',
      image: './Dockerfile.sandbox',
      imageBuildContext: '.',
      platformImage: 'registry.example.com/code-sandbox:latest',
      instanceType: 'basic',
      maxInstances: 3,
    });
    cleanup();
  });

  it('preserves registry sandbox images when resolving config', () => {
    const config = resolveSandboxConfig(
      {
        sandbox: {
          image: 'docker.io/cloudflare/sandbox:0.8.11',
        },
      },
      tmpDir,
    );

    expect(config.image).toBe('docker.io/cloudflare/sandbox:0.8.11');
    expect(config.platformImage).toBe('docker.io/cloudflare/sandbox:0.8.11');
  });

  it('throws on invalid sandbox config', () => {
    setup(JSON.stringify({ sandbox: { instanceType: 'huge' } }));
    expect(() => readConfig(tmpDir)).toThrow('"sandbox.instanceType"');
    cleanup();

    setup(JSON.stringify({ sandbox: { maxInstances: 0 } }));
    expect(() => readConfig(tmpDir)).toThrow('"sandbox.maxInstances"');
    cleanup();
  });

  it('throws on invalid appType', () => {
    setup(JSON.stringify({ inference: { appType: 'serverless' } }));
    expect(() => readConfig(tmpDir)).toThrow('must be one of: spa, static, void');
    cleanup();
  });

  it('throws on non-string outputDir', () => {
    setup(JSON.stringify({ inference: { outputDir: 42 } }));
    expect(() => readConfig(tmpDir)).toThrow('must be a string');
    cleanup();
  });

  it('throws on header pattern not starting with /', () => {
    setup(
      JSON.stringify({
        routing: { headers: { 'assets/*': ['Cache-Control: no-cache'] } },
      }),
    );
    expect(() => readConfig(tmpDir)).toThrow('must start with "/"');
    cleanup();
  });

  it('throws on non-array header values', () => {
    setup(JSON.stringify({ routing: { headers: { '/*': 'X-Frame-Options: DENY' } } }));
    expect(() => readConfig(tmpDir)).toThrow('must be an array of strings');
    cleanup();
  });

  it('throws on invalid worker type', () => {
    setup(JSON.stringify({ worker: 'yes' }));
    expect(() => readConfig(tmpDir)).toThrow('"worker"');
    cleanup();
  });

  it('throws on invalid compatibility_date format', () => {
    setup(JSON.stringify({ worker: { compatibility_date: 'not-a-date' } }));
    expect(() => readConfig(tmpDir)).toThrow('YYYY-MM-DD format');
    cleanup();
  });

  it('throws on partial compatibility_date format', () => {
    setup(JSON.stringify({ worker: { compatibility_date: '2026-02' } }));
    expect(() => readConfig(tmpDir)).toThrow('YYYY-MM-DD format');
    cleanup();
  });

  it('accepts valid compatibility_date format', () => {
    setup(JSON.stringify({ worker: { compatibility_date: '2026-02-24' } }));
    const config = readConfig(tmpDir);
    expect(config.worker?.compatibility_date).toBe('2026-02-24');
    cleanup();
  });

  it('accepts routing.revalidate as a number', () => {
    setup(JSON.stringify({ routing: { revalidate: 60 } }));
    const config = readConfig(tmpDir);
    expect(config.routing?.revalidate).toBe(60);
    cleanup();
  });

  it('accepts routing.revalidate as zero', () => {
    setup(JSON.stringify({ routing: { revalidate: 0 } }));
    const config = readConfig(tmpDir);
    expect(config.routing?.revalidate).toBe(0);
    cleanup();
  });

  it('accepts routing.revalidate as a path map', () => {
    setup(
      JSON.stringify({
        routing: { revalidate: { '/': 60, '/docs/*': 31536000, '*': 30 } },
      }),
    );
    const config = readConfig(tmpDir);
    expect(config.routing?.revalidate).toEqual({ '/': 60, '/docs/*': 31536000, '*': 30 });
    cleanup();
  });

  it('throws on negative routing.revalidate number', () => {
    setup(JSON.stringify({ routing: { revalidate: -1 } }));
    expect(() => readConfig(tmpDir)).toThrow('"routing.revalidate"');
    cleanup();
  });

  it('throws on string routing.revalidate', () => {
    setup(JSON.stringify({ routing: { revalidate: '60' } }));
    expect(() => readConfig(tmpDir)).toThrow('"routing.revalidate"');
    cleanup();
  });

  it('throws on non-numeric routing.revalidate path map value', () => {
    setup(JSON.stringify({ routing: { revalidate: { '/': '60' } } }));
    expect(() => readConfig(tmpDir)).toThrow('"routing.revalidate"');
    cleanup();
  });

  it('throws on negative routing.revalidate path map value', () => {
    setup(JSON.stringify({ routing: { revalidate: { '/': -10 } } }));
    expect(() => readConfig(tmpDir)).toThrow('"routing.revalidate"');
    cleanup();
  });

  it('throws on routing.revalidate path map key not starting with / or *', () => {
    setup(JSON.stringify({ routing: { revalidate: { docs: 60 } } }));
    expect(() => readConfig(tmpDir)).toThrow('"routing.revalidate"');
    cleanup();
  });

  it('throws on invalid routing type', () => {
    setup(JSON.stringify({ routing: 'invalid' }));
    expect(() => readConfig(tmpDir)).toThrow('"routing" in void.json must be an object');
    cleanup();
  });

  it('accepts empty routing object', () => {
    setup(JSON.stringify({ routing: {} }));
    const config = readConfig(tmpDir);
    expect(config.routing).toEqual({});
    cleanup();
  });

  it('accepts build command string', () => {
    setup(JSON.stringify({ inference: { build: 'nuxt build' } }));
    const config = readConfig(tmpDir);
    expect(config.inference?.build).toBe('nuxt build');
    cleanup();
  });

  it('throws on non-string build', () => {
    setup(JSON.stringify({ inference: { build: true } }));
    expect(() => readConfig(tmpDir)).toThrow('"inference.build" in void.json must be a string');
    cleanup();
  });

  it('accepts routing.prerender paths', () => {
    setup(JSON.stringify({ routing: { prerender: ['/', '/about', '/docs/intro'] } }));
    const config = readConfig(tmpDir);
    expect(config.routing?.prerender).toEqual(['/', '/about', '/docs/intro']);
    cleanup();
  });

  it('throws on non-array routing.prerender', () => {
    setup(JSON.stringify({ routing: { prerender: '/about' } }));
    expect(() => readConfig(tmpDir)).toThrow('"routing.prerender" in void.json must be an array');
    cleanup();
  });

  it('throws on routing.prerender path not starting with /', () => {
    setup(JSON.stringify({ routing: { prerender: ['about'] } }));
    expect(() => readConfig(tmpDir)).toThrow('must start with "/"');
    cleanup();
  });

  it('accepts scanDirs as array of strings', () => {
    setup(JSON.stringify({ inference: { scanDirs: ['src', 'lib', 'server'] } }));
    const config = readConfig(tmpDir);
    expect(config.inference?.scanDirs).toEqual(['src', 'lib', 'server']);
    cleanup();
  });

  it('throws on non-array scanDirs', () => {
    setup(JSON.stringify({ inference: { scanDirs: 'src' } }));
    expect(() => readConfig(tmpDir)).toThrow('"inference.scanDirs" in void.json must be an array');
    cleanup();
  });

  it('throws on absolute path in scanDirs', () => {
    setup(JSON.stringify({ inference: { scanDirs: ['/etc/passwd'] } }));
    expect(() => readConfig(tmpDir)).toThrow('must be a relative directory');
    cleanup();
  });

  it('throws on parent traversal in scanDirs', () => {
    setup(JSON.stringify({ inference: { scanDirs: ['../secrets'] } }));
    expect(() => readConfig(tmpDir)).toThrow('must be a relative directory');
    cleanup();
  });
});

describe('readConfig migration errors', () => {
  it('throws when auth is not an object', () => {
    setup(JSON.stringify({ auth: ['github'] }));
    expect(() => readConfig(tmpDir)).toThrow('"auth" in void.json must be an object');
    cleanup();
  });

  it('throws migration error when old flat bindings key is used', () => {
    setup(JSON.stringify({ bindings: { db: true } }));
    expect(() => readConfig(tmpDir)).toThrow('"bindings" has moved to "inference.bindings"');
    cleanup();
  });

  it('throws migration error when old flat headers key is used', () => {
    setup(JSON.stringify({ headers: { '/*': ['X-Frame-Options: DENY'] } }));
    expect(() => readConfig(tmpDir)).toThrow('"headers" has moved to "routing.headers"');
    cleanup();
  });

  it('throws migration error when old flat redirects key is used', () => {
    setup(JSON.stringify({ redirects: { '/old': '/new' } }));
    expect(() => readConfig(tmpDir)).toThrow('"redirects" has moved to "routing.redirects"');
    cleanup();
  });

  it('throws migration error when old cache key is used', () => {
    setup(JSON.stringify({ cache: { revalidate: 60 } }));
    expect(() => readConfig(tmpDir)).toThrow('"cache" has been replaced by "routing"');
    cleanup();
  });

  it('throws migration error when old wrangler key is used', () => {
    setup(JSON.stringify({ wrangler: { compatibility_date: '2025-12-01' } }));
    expect(() => readConfig(tmpDir)).toThrow('"wrangler" has been renamed to "worker"');
    cleanup();
  });

  it('throws migration error when old mode key is used', () => {
    setup(JSON.stringify({ mode: 'spa' }));
    expect(() => readConfig(tmpDir)).toThrow('"mode" has been renamed to "inference.appType"');
    cleanup();
  });

  it('throws migration error when old flat build key is used', () => {
    setup(JSON.stringify({ build: 'nuxt build' }));
    expect(() => readConfig(tmpDir)).toThrow('"build" has moved to "inference.build"');
    cleanup();
  });

  it('throws migration error when old flat scanDirs key is used', () => {
    setup(JSON.stringify({ scanDirs: ['src'] }));
    expect(() => readConfig(tmpDir)).toThrow('"scanDirs" has moved to "inference.scanDirs"');
    cleanup();
  });

  it('throws migration error when old flat appType key is used', () => {
    setup(JSON.stringify({ appType: 'spa' }));
    expect(() => readConfig(tmpDir)).toThrow('"appType" has moved to "inference.appType"');
    cleanup();
  });

  it('throws migration error when old flat outputDir key is used', () => {
    setup(JSON.stringify({ outputDir: 'dist' }));
    expect(() => readConfig(tmpDir)).toThrow('"outputDir" has moved to "inference.outputDir"');
    cleanup();
  });

  it('throws migration error when old top-level revalidate is used', () => {
    setup(JSON.stringify({ revalidate: 60 }));
    expect(() => readConfig(tmpDir)).toThrow('"revalidate" has moved to "routing.revalidate"');
    cleanup();
  });
});

describe('readConfig target', () => {
  it('accepts valid target values', () => {
    for (const target of ['cloudflare', 'node', 'bun', 'deno']) {
      setup(JSON.stringify({ target }));
      const config = readConfig(tmpDir);
      expect(config.target).toBe(target);
      cleanup();
    }
  });

  it('defaults target to undefined (cloudflare is implicit default)', () => {
    setup(JSON.stringify({}));
    const config = readConfig(tmpDir);
    expect(config.target).toBeUndefined();
    cleanup();
  });

  it('rejects invalid target value', () => {
    setup(JSON.stringify({ target: 'lambda' }));
    expect(() => readConfig(tmpDir)).toThrow('"target" in void.json must be one of');
    cleanup();
  });

  it('warns on CF-only fields with non-CF target via isNodeTarget', () => {
    expect(isNodeTarget('node')).toBe(true);
    expect(isNodeTarget('bun')).toBe(true);
    expect(isNodeTarget('deno')).toBe(true);
    expect(isNodeTarget(undefined)).toBe(false);
    expect(isNodeTarget('cloudflare')).toBe(false);
  });
});

describe('readConfig redirects', () => {
  it('accepts redirects with string destinations', () => {
    setup(JSON.stringify({ routing: { redirects: { '/old': '/new' } } }));
    const config = readConfig(tmpDir);
    expect(config.routing?.redirects).toEqual({ '/old': '/new' });
    cleanup();
  });

  it('accepts redirects with object destinations', () => {
    setup(JSON.stringify({ routing: { redirects: { '/old': { to: '/new', status: 301 } } } }));
    const config = readConfig(tmpDir);
    expect(config.routing?.redirects).toEqual({ '/old': { to: '/new', status: 301 } });
    cleanup();
  });

  it('accepts mixed string and object destinations', () => {
    setup(
      JSON.stringify({
        routing: {
          redirects: {
            '/a': '/b',
            '/c': { to: '/d', status: 308 },
          },
        },
      }),
    );
    const config = readConfig(tmpDir);
    expect(config.routing?.redirects).toEqual({
      '/a': '/b',
      '/c': { to: '/d', status: 308 },
    });
    cleanup();
  });

  it('throws on redirect source not starting with /', () => {
    setup(JSON.stringify({ routing: { redirects: { old: '/new' } } }));
    expect(() => readConfig(tmpDir)).toThrow('must start with "/"');
    cleanup();
  });

  it('throws on invalid redirects type', () => {
    setup(JSON.stringify({ routing: { redirects: ['/old', '/new'] } }));
    expect(() => readConfig(tmpDir)).toThrow('"routing.redirects" in void.json must be an object');
    cleanup();
  });

  it('throws on invalid destination type', () => {
    setup(JSON.stringify({ routing: { redirects: { '/old': 42 } } }));
    expect(() => readConfig(tmpDir)).toThrow('must be a string or an object');
    cleanup();
  });

  it("throws on missing 'to' in object destination", () => {
    setup(JSON.stringify({ routing: { redirects: { '/old': { status: 301 } } } }));
    expect(() => readConfig(tmpDir)).toThrow('must have a "to" string');
    cleanup();
  });

  it('throws on invalid status code', () => {
    setup(JSON.stringify({ routing: { redirects: { '/old': { to: '/new', status: 200 } } } }));
    expect(() => readConfig(tmpDir)).toThrow('must be 301, 302, 303, 307, or 308');
    cleanup();
  });

  it('accepts status 303', () => {
    setup(JSON.stringify({ routing: { redirects: { '/old': { to: '/new', status: 303 } } } }));
    const config = readConfig(tmpDir);
    expect(config.routing?.redirects).toEqual({ '/old': { to: '/new', status: 303 } });
    cleanup();
  });

  it('schema.json redirect status enum matches VALID_REDIRECT_STATUSES', () => {
    const schema = JSON.parse(readFileSync(join(import.meta.dirname, '../../schema.json'), 'utf8'));
    const schemaEnum: Array<number> =
      schema.properties.routing.properties.redirects.patternProperties['^/'].oneOf[1].properties
        .status.enum;
    expect(new Set(schemaEnum)).toEqual(VALID_REDIRECT_STATUSES);
  });
});

describe('routing.rewrites validation', () => {
  it('accepts valid rewrites', () => {
    setup(JSON.stringify({ routing: { rewrites: { '/docs': '/en/docs' } } }));
    const config = readConfig(tmpDir);
    expect(config.routing?.rewrites).toEqual({ '/docs': '/en/docs' });
    cleanup();
  });

  it('throws when rewrites is not an object', () => {
    setup(JSON.stringify({ routing: { rewrites: ['/old', '/new'] } }));
    expect(() => readConfig(tmpDir)).toThrow('"routing.rewrites" in void.json must be an object');
    cleanup();
  });

  it('throws when source does not start with /', () => {
    setup(JSON.stringify({ routing: { rewrites: { docs: '/en/docs' } } }));
    expect(() => readConfig(tmpDir)).toThrow('must start with "/"');
    cleanup();
  });

  it('throws when destination is not a string', () => {
    setup(JSON.stringify({ routing: { rewrites: { '/docs': 42 } } }));
    expect(() => readConfig(tmpDir)).toThrow('must be a string');
    cleanup();
  });

  it('throws when destination does not start with /', () => {
    setup(JSON.stringify({ routing: { rewrites: { '/docs': 'en/docs' } } }));
    expect(() => readConfig(tmpDir)).toThrow('must start with "/"');
    cleanup();
  });

  it('throws when destination contains a query string', () => {
    setup(JSON.stringify({ routing: { rewrites: { '/docs': '/en/docs?lang=en' } } }));
    expect(() => readConfig(tmpDir)).toThrow('must not contain "?"');
    cleanup();
  });

  it('throws when destination is protocol-relative ("//host/x")', () => {
    // Mirrors the `c.rewrite()` codegen guard in router/compile.ts (commit
    // 3c60d38). `"//evil.com/x".startsWith("/")` is true, so a naive
    // single-slash check lets the value through — but when the manifest is
    // applied at dispatch, `new URL("//evil.com/x", base)` resolves to
    // `https://evil.com/x` and turns the rewrite into a cross-origin proxy.
    setup(JSON.stringify({ routing: { rewrites: { '/docs': '//evil.com/x' } } }));
    expect(() => readConfig(tmpDir)).toThrow('must not start with "//"');
    cleanup();
  });
});

describe('routing.fallbacks validation', () => {
  it('accepts valid fallbacks', () => {
    setup(JSON.stringify({ routing: { fallbacks: { '/*': '/index.html' } } }));
    const config = readConfig(tmpDir);
    expect(config.routing?.fallbacks).toEqual({ '/*': '/index.html' });
    cleanup();
  });

  it('throws when fallbacks is not an object', () => {
    setup(JSON.stringify({ routing: { fallbacks: ['/*', '/index.html'] } }));
    expect(() => readConfig(tmpDir)).toThrow('"routing.fallbacks" in void.json must be an object');
    cleanup();
  });

  it('throws when source does not start with /', () => {
    setup(JSON.stringify({ routing: { fallbacks: { '*': '/index.html' } } }));
    expect(() => readConfig(tmpDir)).toThrow('must start with "/"');
    cleanup();
  });

  it('throws when destination is not a string', () => {
    setup(JSON.stringify({ routing: { fallbacks: { '/*': 42 } } }));
    expect(() => readConfig(tmpDir)).toThrow('must be a string');
    cleanup();
  });

  it('throws when destination does not start with /', () => {
    setup(JSON.stringify({ routing: { fallbacks: { '/*': 'index.html' } } }));
    expect(() => readConfig(tmpDir)).toThrow('must start with "/"');
    cleanup();
  });

  it('throws when destination contains a query string', () => {
    setup(JSON.stringify({ routing: { fallbacks: { '/*': '/index.html?foo=1' } } }));
    expect(() => readConfig(tmpDir)).toThrow('must not contain "?"');
    cleanup();
  });

  it('throws when destination is protocol-relative ("//host/x")', () => {
    // Symmetric with the rewrites guard — fallbacks reach the platform via
    // the same manifest path, so the same cross-origin hazard applies.
    setup(JSON.stringify({ routing: { fallbacks: { '/*': '//evil.com/index.html' } } }));
    expect(() => readConfig(tmpDir)).toThrow('must not start with "//"');
    cleanup();
  });
});

describe('routing.redirects protocol-relative guard', () => {
  // Redirects legitimately support external destinations ("https://..."), so
  // the guard only applies when the destination is an internal path ("/..").
  it('throws on string destination starting with "//"', () => {
    setup(JSON.stringify({ routing: { redirects: { '/old': '//evil.com/new' } } }));
    expect(() => readConfig(tmpDir)).toThrow('must not start with "//"');
    cleanup();
  });

  it('throws on object destination with `to` starting with "//"', () => {
    setup(
      JSON.stringify({
        routing: { redirects: { '/old': { to: '//evil.com/new', status: 301 } } },
      }),
    );
    expect(() => readConfig(tmpDir)).toThrow('must not start with "//"');
    cleanup();
  });

  it('still accepts explicit "https://" external destinations', () => {
    setup(
      JSON.stringify({
        routing: { redirects: { '/old': 'https://example.com/new' } },
      }),
    );
    const config = readConfig(tmpDir);
    expect(config.routing?.redirects).toEqual({ '/old': 'https://example.com/new' });
    cleanup();
  });
});

describe('duplicate "*" wildcards in rule sources', () => {
  // Dispatch compiles each `*` into a `(?<splat>...)` capture group, so two
  // in one source makes `new RegExp()` throw on duplicate group name at
  // startup. Catch these at config-read time with a clear message.
  it('rejects a redirect source with two "*"', () => {
    setup(JSON.stringify({ routing: { redirects: { '/a/*/b/*': '/dest' } } }));
    expect(() => readConfig(tmpDir)).toThrow('must contain at most one "*" wildcard');
    cleanup();
  });

  it('rejects a rewrite source with two "*"', () => {
    setup(JSON.stringify({ routing: { rewrites: { '/*/docs/*': '/dest' } } }));
    expect(() => readConfig(tmpDir)).toThrow('must contain at most one "*" wildcard');
    cleanup();
  });

  it('rejects a fallback source with two "*"', () => {
    setup(JSON.stringify({ routing: { fallbacks: { '/*/*': '/index.html' } } }));
    expect(() => readConfig(tmpDir)).toThrow('must contain at most one "*" wildcard');
    cleanup();
  });

  it('accepts a header pattern with multiple "*"', () => {
    setup(
      JSON.stringify({ routing: { headers: { '/assets/*/img/*': ['Cache-Control: no-cache'] } } }),
    );
    const config = readConfig(tmpDir);
    expect(config.routing?.headers).toEqual({
      '/assets/*/img/*': ['Cache-Control: no-cache'],
    });
    cleanup();
  });

  it('accepts a source with exactly one "*"', () => {
    setup(JSON.stringify({ routing: { rewrites: { '/docs/*': '/en/docs/:splat' } } }));
    const config = readConfig(tmpDir);
    expect(config.routing?.rewrites).toEqual({ '/docs/*': '/en/docs/:splat' });
    cleanup();
  });

  it('accepts a source with zero "*"', () => {
    setup(JSON.stringify({ routing: { rewrites: { '/docs': '/en/docs' } } }));
    const config = readConfig(tmpDir);
    expect(config.routing?.rewrites).toEqual({ '/docs': '/en/docs' });
    cleanup();
  });
});

describe('routing.revalidateQueryAllowlist validation', () => {
  it('accepts path-pattern arrays', () => {
    setup(
      JSON.stringify({
        routing: {
          revalidateQueryAllowlist: {
            '/search': ['q'],
            '/products/*': ['variant'],
            '*': [],
          },
        },
      }),
    );
    const config = readConfig(tmpDir);
    expect(config.routing?.revalidateQueryAllowlist).toEqual({
      '/search': ['q'],
      '/products/*': ['variant'],
      '*': [],
    });
    cleanup();
  });

  it('throws when allowlist is not an object', () => {
    setup(JSON.stringify({ routing: { revalidateQueryAllowlist: ['/search'] } }));
    expect(() => readConfig(tmpDir)).toThrow(
      '"routing.revalidateQueryAllowlist" in void.json must be an object',
    );
    cleanup();
  });

  it('throws when pattern does not start with /', () => {
    setup(JSON.stringify({ routing: { revalidateQueryAllowlist: { search: ['q'] } } }));
    expect(() => readConfig(tmpDir)).toThrow('must start with "/" or be "*"');
    cleanup();
  });

  it('throws when params are not string arrays', () => {
    setup(JSON.stringify({ routing: { revalidateQueryAllowlist: { '/search': ['q', 1] } } }));
    expect(() => readConfig(tmpDir)).toThrow('must be an array of strings');
    cleanup();
  });
});

describe('convertHeadersConfig', () => {
  it('returns undefined for undefined input', () => {
    expect(convertHeadersConfig(undefined)).toBeUndefined();
  });

  it('returns undefined for empty object', () => {
    expect(convertHeadersConfig({})).toBeUndefined();
  });

  it('converts a single pattern with one header', () => {
    const result = convertHeadersConfig({
      '/assets/*': ['Cache-Control: public, max-age=31536000, immutable'],
    });
    expect(result).toEqual([
      {
        pattern: '/assets/*',
        headers: [['Cache-Control', 'public, max-age=31536000, immutable']],
      },
    ]);
  });

  it('converts multiple patterns with multiple headers', () => {
    const result = convertHeadersConfig({
      '/assets/*': ['Cache-Control: public, max-age=31536000, immutable'],
      '/*': ['X-Frame-Options: DENY', 'X-Content-Type-Options: nosniff'],
    });
    expect(result).toEqual([
      {
        pattern: '/assets/*',
        headers: [['Cache-Control', 'public, max-age=31536000, immutable']],
      },
      {
        pattern: '/*',
        headers: [
          ['X-Frame-Options', 'DENY'],
          ['X-Content-Type-Options', 'nosniff'],
        ],
      },
    ]);
  });

  it('handles header values with colons', () => {
    const result = convertHeadersConfig({
      '/api/*': ['Link: <https://example.com>; rel="preconnect"'],
    });
    expect(result).toEqual([
      {
        pattern: '/api/*',
        headers: [['Link', '<https://example.com>; rel="preconnect"']],
      },
    ]);
  });

  it('skips entries without colons', () => {
    const result = convertHeadersConfig({
      '/*': ['not-a-header', 'X-Frame-Options: DENY'],
    });
    expect(result).toEqual([
      {
        pattern: '/*',
        headers: [['X-Frame-Options', 'DENY']],
      },
    ]);
  });

  it('skips patterns with only invalid entries', () => {
    const result = convertHeadersConfig({
      '/assets/*': ['Cache-Control: ok'],
      '/*': ['not-a-header'],
    });
    expect(result).toEqual([
      {
        pattern: '/assets/*',
        headers: [['Cache-Control', 'ok']],
      },
    ]);
  });
});

describe('convertRedirectsConfig', () => {
  it('returns undefined for undefined input', () => {
    expect(convertRedirectsConfig(undefined)).toBeUndefined();
  });

  it('returns undefined for empty object', () => {
    expect(convertRedirectsConfig({})).toBeUndefined();
  });

  it('converts string destinations with default 302', () => {
    const result = convertRedirectsConfig({ '/old': '/new' });
    expect(result).toEqual([
      { source: '/old', destination: '/new', status: 302, origin: 'void.json#routing.redirects' },
    ]);
  });

  it('converts object destinations with explicit status', () => {
    const result = convertRedirectsConfig({ '/old': { to: '/new', status: 301 } });
    expect(result).toEqual([
      { source: '/old', destination: '/new', status: 301, origin: 'void.json#routing.redirects' },
    ]);
  });

  it('converts mixed entries preserving order', () => {
    const result = convertRedirectsConfig({
      '/a': '/b',
      '/c/*': { to: '/d/:splat', status: 308 },
    });
    expect(result).toEqual([
      { source: '/a', destination: '/b', status: 302, origin: 'void.json#routing.redirects' },
      {
        source: '/c/*',
        destination: '/d/:splat',
        status: 308,
        origin: 'void.json#routing.redirects',
      },
    ]);
  });
});

describe('convertRewritesConfig', () => {
  it('returns undefined for undefined input', () => {
    expect(convertRewritesConfig(undefined)).toBeUndefined();
  });

  it('returns undefined for empty object', () => {
    expect(convertRewritesConfig({})).toBeUndefined();
  });

  it('converts entries with status 200 and force=true (always-rewrite)', () => {
    const result = convertRewritesConfig({ '/docs': '/en/docs' });
    expect(result).toEqual([
      {
        source: '/docs',
        destination: '/en/docs',
        status: 200,
        force: true,
        origin: 'void.json#routing.rewrites',
      },
    ]);
  });

  it('converts multiple entries preserving order', () => {
    const result = convertRewritesConfig({
      '/': '/en',
      '/docs/*': '/en/docs/:splat',
    });
    expect(result).toEqual([
      {
        source: '/',
        destination: '/en',
        status: 200,
        force: true,
        origin: 'void.json#routing.rewrites',
      },
      {
        source: '/docs/*',
        destination: '/en/docs/:splat',
        status: 200,
        force: true,
        origin: 'void.json#routing.rewrites',
      },
    ]);
  });
});

describe('convertFallbacksConfig', () => {
  it('returns undefined for undefined input', () => {
    expect(convertFallbacksConfig(undefined)).toBeUndefined();
  });

  it('returns undefined for empty object', () => {
    expect(convertFallbacksConfig({})).toBeUndefined();
  });

  it('converts entries with status 200 and force=false (asset-miss only)', () => {
    const result = convertFallbacksConfig({ '/*': '/index.html' });
    expect(result).toEqual([
      {
        source: '/*',
        destination: '/index.html',
        status: 200,
        force: false,
        origin: 'void.json#routing.fallbacks',
      },
    ]);
  });

  it('converts multiple entries preserving order', () => {
    const result = convertFallbacksConfig({
      '/api/*': '/api/fallback',
      '/*': '/index.html',
    });
    expect(result).toEqual([
      {
        source: '/api/*',
        destination: '/api/fallback',
        status: 200,
        force: false,
        origin: 'void.json#routing.fallbacks',
      },
      {
        source: '/*',
        destination: '/index.html',
        status: 200,
        force: false,
        origin: 'void.json#routing.fallbacks',
      },
    ]);
  });
});

describe('lintDestinationSplats', () => {
  beforeEach(() => {
    warnMock.mockClear();
  });

  // Platform `substituteParams` only replaces `:name` tokens — a literal `*`
  // in a destination passes through unchanged, which is almost never what the
  // author meant. Warn (not fail) so misuse surfaces at deploy-time without
  // blocking otherwise-valid configs.
  it('emits no warning when destinations only contain :splat / :name', async () => {
    const { lintDestinationSplats } = await import('../../src/cli/headers');
    const rules = convertRewritesConfig({
      '/docs/*': '/en/docs/:splat',
      '/posts/:id': '/archive/:id',
    });
    lintDestinationSplats(rules, 'rewrites');
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('emits a single aggregated warning for a redirect destination with *', async () => {
    const { lintDestinationSplats } = await import('../../src/cli/headers');
    const rules = convertRedirectsConfig({ '/old/*': '/new/*' });
    lintDestinationSplats(rules, 'redirects/rewrites (pre-asset)');
    expect(warnMock).toHaveBeenCalledOnce();
    const msg = warnMock.mock.calls[0][0];
    expect(msg).toContain('/old/*');
    expect(msg).toContain('/new/*');
    expect(msg).toContain('void.json#routing.redirects');
  });

  it('emits a single aggregated warning covering all affected rules', async () => {
    const { lintDestinationSplats } = await import('../../src/cli/headers');
    const rules = [
      ...(convertRewritesConfig({ '/a/*': '/x/*' }) ?? []),
      ...(convertRewritesConfig({ '/b/*': '/y/:splat' }) ?? []),
      ...(convertRewritesConfig({ '/c': '/z/*' }) ?? []),
    ];
    lintDestinationSplats(rules, 'rewrites');
    expect(warnMock).toHaveBeenCalledOnce();
    const msg = warnMock.mock.calls[0][0];
    expect(msg).toContain('/a/*');
    expect(msg).toContain('/x/*');
    expect(msg).toContain('/c');
    expect(msg).toContain('/z/*');
    // The rule with a clean `:splat` destination must not appear.
    expect(msg).not.toContain('/y/:splat');
  });

  it('works with fallbacks output shape as well', async () => {
    const { lintDestinationSplats } = await import('../../src/cli/headers');
    const rules = convertFallbacksConfig({ '/docs/*': '/docs/*' });
    lintDestinationSplats(rules, 'fallbacks (post-asset)');
    expect(warnMock).toHaveBeenCalledOnce();
    expect(warnMock.mock.calls[0][0]).toContain('void.json#routing.fallbacks');
  });
});

describe('database config', () => {
  it('defaults to sqlite when omitted', () => {
    setup('{}');
    const config = readConfig(tmpDir);
    expect(getDatabaseDialect(config)).toBe('sqlite');
    cleanup();
  });

  it('defaults to sqlite for empty config', () => {
    setup();
    expect(getDatabaseDialect({})).toBe('sqlite');
  });

  it('accepts pg', () => {
    setup(JSON.stringify({ database: 'pg' }));
    const config = readConfig(tmpDir);
    expect(getDatabaseDialect(config)).toBe('postgresql');
    cleanup();
  });

  it('rejects invalid value', () => {
    setup(JSON.stringify({ database: 'mysql' }));
    expect(() => readConfig(tmpDir)).toThrow('"database" in void.json must be "pg"');
    cleanup();
  });

  it('rejects object value', () => {
    setup(JSON.stringify({ database: { dialect: 'pg' } }));
    expect(() => readConfig(tmpDir)).toThrow('"database" in void.json must be "pg"');
    cleanup();
  });
});

describe('resolveBindingNames', () => {
  it('returns undefined for no bindings', () => {
    expect(resolveBindingNames(undefined)).toBeUndefined();
  });

  it('returns undefined for boolean-only bindings', () => {
    expect(resolveBindingNames({ db: true, kv: true })).toBeUndefined();
  });

  it('returns custom names for string bindings', () => {
    expect(resolveBindingNames({ db: 'MY_DB', kv: true, storage: 'BUCKET' })).toEqual({
      d1: 'MY_DB',
      r2: 'BUCKET',
    });
  });

  it('returns all custom names', () => {
    expect(resolveBindingNames({ db: 'D', kv: 'K', storage: 'S' })).toEqual({
      d1: 'D',
      kv: 'K',
      r2: 'S',
    });
  });
});
