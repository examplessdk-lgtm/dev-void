import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vite-plus/test';
import {
  expandDotenv,
  parseDotenv,
  parseDotenvFile,
  parseDotenvLine,
  scanWranglerDotenvKeys,
} from '../../src/shared/dotenv.ts';

/**
 * Parser + expander unit coverage. These are the lowest-level helpers behind
 * every CLI path that reads `.env*` files, so we want deliberate regression
 * tests for the expansion edge cases: escapes, nested refs, cycles, missing
 * refs, and the no-process.env guarantee.
 */

describe('parseDotenvLine', () => {
  it('parses basic KEY=VALUE', () => {
    expect(parseDotenvLine('FOO=bar')).toEqual({ key: 'FOO', value: 'bar' });
  });

  it('strips matching double quotes', () => {
    expect(parseDotenvLine('FOO="bar baz"')).toEqual({ key: 'FOO', value: 'bar baz' });
  });

  it('strips matching single quotes', () => {
    expect(parseDotenvLine("FOO='bar baz'")).toEqual({ key: 'FOO', value: 'bar baz' });
  });

  it('returns null for blanks and comments', () => {
    expect(parseDotenvLine('')).toBeNull();
    expect(parseDotenvLine('   ')).toBeNull();
    expect(parseDotenvLine('# comment')).toBeNull();
  });

  it('returns null for lines without =', () => {
    expect(parseDotenvLine('NO_EQUALS')).toBeNull();
  });
});

describe('parseDotenv', () => {
  it('parses a multi-line file', () => {
    const out = parseDotenv('A=1\nB=2\n# comment\n\nC=3\n');
    expect(out).toEqual({ A: '1', B: '2', C: '3' });
  });

  it('skips invalid keys by default', () => {
    const out = parseDotenv('GOOD=1\n1BAD=2\nALSO-BAD=3\n');
    expect(out).toEqual({ GOOD: '1' });
  });

  it('throws on invalid keys when skipInvalidKeys=false', () => {
    expect(() => parseDotenv('1BAD=2\n', { skipInvalidKeys: false })).toThrow(
      /dotenv: Invalid key/,
    );
  });

  it('expands by default', () => {
    const out = parseDotenv('BASE=https://example.com\nAPI=${BASE}/v1\n');
    expect(out).toEqual({ BASE: 'https://example.com', API: 'https://example.com/v1' });
  });

  it('skips expansion when expand=false', () => {
    const out = parseDotenv('BASE=https://example.com\nAPI=${BASE}/v1\n', { expand: false });
    expect(out.API).toBe('${BASE}/v1');
  });
});

describe('parseDotenvFile', () => {
  it('returns {} for a missing file', () => {
    expect(parseDotenvFile('/definitely/not/a/real/path/.env')).toEqual({});
  });

  it('reads an on-disk file and expands', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-dotenv-'));
    const file = join(root, '.env');
    writeFileSync(file, 'HOST=api.example.com\nURL=https://${HOST}\n');
    expect(parseDotenvFile(file)).toEqual({
      HOST: 'api.example.com',
      URL: 'https://api.example.com',
    });
  });
});

describe('expandDotenv — ${VAR} form', () => {
  it('resolves a single reference', () => {
    expect(expandDotenv({ BASE: 'https://a.com', URL: '${BASE}/v1' })).toEqual({
      BASE: 'https://a.com',
      URL: 'https://a.com/v1',
    });
  });

  it('resolves nested references transitively', () => {
    expect(expandDotenv({ A: '${B}', B: '${C}', C: 'deep' })).toEqual({
      A: 'deep',
      B: 'deep',
      C: 'deep',
    });
  });

  it('expands multiple refs in a single value', () => {
    expect(expandDotenv({ A: '1', B: '2', C: '${A}-${B}' })).toEqual({
      A: '1',
      B: '2',
      C: '1-2',
    });
  });

  it('expands to empty string for missing references', () => {
    expect(expandDotenv({ URL: '${MISSING}/path' })).toEqual({ URL: '/path' });
  });

  it('leaves unterminated ${... literally', () => {
    expect(expandDotenv({ A: '${UNCLOSED' })).toEqual({ A: '${UNCLOSED' });
  });

  it('leaves ${<non-identifier>} literally', () => {
    expect(expandDotenv({ A: '${1BAD}' })).toEqual({ A: '${1BAD}' });
  });
});

describe('expandDotenv — $VAR bare form', () => {
  it('resolves a bare ref up to the first non-identifier char', () => {
    expect(expandDotenv({ NAME: 'alice', GREET: 'hi $NAME!' })).toEqual({
      NAME: 'alice',
      GREET: 'hi alice!',
    });
  });

  it('stops at hyphens and slashes', () => {
    expect(expandDotenv({ HOST: 'x', URL: 'http://$HOST/path' })).toEqual({
      HOST: 'x',
      URL: 'http://x/path',
    });
  });

  it('leaves a bare $ alone when not followed by an identifier', () => {
    expect(expandDotenv({ A: 'cost $5' })).toEqual({ A: 'cost $5' });
    expect(expandDotenv({ A: 'trailing $' })).toEqual({ A: 'trailing $' });
  });
});

describe('expandDotenv — escapes', () => {
  it('treats \\$VAR as a literal $VAR (consuming the backslash)', () => {
    expect(expandDotenv({ A: '\\$NOT_EXPANDED' })).toEqual({ A: '$NOT_EXPANDED' });
  });

  it('treats \\${VAR} as a literal ${VAR}', () => {
    expect(expandDotenv({ A: '\\${LITERAL}' })).toEqual({ A: '${LITERAL}' });
  });

  it('mixes escaped and non-escaped refs in one value', () => {
    expect(expandDotenv({ X: 'real', A: '\\$X and $X' })).toEqual({
      X: 'real',
      A: '$X and real',
    });
  });
});

describe('expandDotenv — cycles', () => {
  it('detects a direct self-cycle and leaves the raw literal', () => {
    const onWarn = vi.fn();
    const out = expandDotenv({ A: '${A}' }, { onWarn });
    expect(out.A).toBe('${A}');
    expect(onWarn).toHaveBeenCalledOnce();
    expect(onWarn.mock.calls[0]![0]).toMatch(/cycle/);
  });

  it('detects an indirect cycle', () => {
    const onWarn = vi.fn();
    const out = expandDotenv({ A: '${B}', B: '${A}' }, { onWarn });
    // Both values short-circuit back to their raw literals.
    expect(out.A).toBeTypeOf('string');
    expect(out.B).toBeTypeOf('string');
    expect(onWarn).toHaveBeenCalled();
  });

  it('does not warn when no cycle is present', () => {
    const onWarn = vi.fn();
    expandDotenv({ A: '${B}', B: 'ok' }, { onWarn });
    expect(onWarn).not.toHaveBeenCalled();
  });
});

describe('expandDotenv — security', () => {
  it('does NOT consult process.env for expansion', () => {
    // A shell env var that isn't in the dotenv record must not leak in.
    const previous = process.env.VOID_DOTENV_EXPAND_TEST;
    process.env.VOID_DOTENV_EXPAND_TEST = 'LEAKED';
    try {
      const out = expandDotenv({ A: '${VOID_DOTENV_EXPAND_TEST}' });
      // Missing refs expand to empty — expressly not the shell value.
      expect(out.A).toBe('');
    } finally {
      if (previous === undefined) {
        delete process.env.VOID_DOTENV_EXPAND_TEST;
      } else {
        process.env.VOID_DOTENV_EXPAND_TEST = previous;
      }
    }
  });
});

describe('scanWranglerDotenvKeys', () => {
  it('reads keys the way Wrangler does, including export and colon forms', () => {
    const dir = mkdtempSync(join(tmpdir(), 'void-dotenv-scan-'));
    const file = join(dir, '.env');
    writeFileSync(
      file,
      [
        '# COMMENTED=1',
        'PLAIN=ok',
        'export EXPORTED=x',
        'COLON: a@b.c',
        'VALUE=has__VOID_inside',
        'MULTI="line one',
        'INSIDE_QUOTES=no"',
        '',
      ].join('\n'),
    );
    expect([...scanWranglerDotenvKeys(file)]).toEqual([
      'PLAIN',
      'EXPORTED',
      'COLON',
      'VALUE',
      'MULTI',
    ]);
  });

  it('returns an empty set for a missing file', () => {
    expect(scanWranglerDotenvKeys('/definitely/not/a/real/path/.env').size).toBe(0);
  });
});
