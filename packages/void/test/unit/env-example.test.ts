import { describe, expect, it } from 'vitest';
import {
  applyMarkerBlock,
  classifySchema,
  ENV_EXAMPLE_END_MARKER,
  ENV_EXAMPLE_START_MARKER,
  formatEnvExample,
} from '../../src/cli/env-example';
import { boolean, json, number, oneOf, string, url } from '../../src/runtime/env-helpers';

describe('classifySchema', () => {
  it('classifies a plain string() as required', () => {
    expect(classifySchema(string())).toEqual({ kind: 'required', enumValues: undefined });
  });

  it('classifies .optional() as optional', () => {
    expect(classifySchema(string().optional())).toEqual({
      kind: 'optional',
      enumValues: undefined,
    });
  });

  it('classifies .default(x) as default with value', () => {
    expect(classifySchema(number().default(3000))).toEqual({
      kind: 'default',
      defaultValue: 3000,
      enumValues: undefined,
    });
  });

  it('classifies boolean().default(false) correctly (falsy default preserved)', () => {
    expect(classifySchema(boolean().default(false))).toEqual({
      kind: 'default',
      defaultValue: false,
      enumValues: undefined,
    });
  });

  it('extracts oneOf enum members for hint comment', () => {
    const schema = oneOf(['development', 'production'] as const);
    expect(classifySchema(schema)).toEqual({
      kind: 'required',
      enumValues: ['development', 'production'],
    });
  });

  it('extracts oneOf enum members even with a default', () => {
    const schema = oneOf(['debug', 'info', 'warn', 'error'] as const).default('info');
    expect(classifySchema(schema)).toEqual({
      kind: 'default',
      defaultValue: 'info',
      enumValues: ['debug', 'info', 'warn', 'error'],
    });
  });

  it('returns no enum hint for non-oneOf schemas', () => {
    expect(classifySchema(url()).enumValues).toBeUndefined();
    expect(classifySchema(json()).enumValues).toBeUndefined();
  });
});

describe('formatEnvExample', () => {
  it('renders the canonical grouped body (no markers)', () => {
    const out = formatEnvExample({
      STRIPE_KEY: string(),
      PORT: number().default(3000),
      DEBUG: boolean().optional(),
      NODE_ENV: oneOf(['development', 'production'] as const),
    });
    // Grouping order, enum hint, and prefilled defaults — no header,
    // no markers; that's the marker block's job.
    expect(out).toBe(
      [
        '# required',
        'STRIPE_KEY=',
        '# enum: development | production',
        'NODE_ENV=',
        '',
        '# with defaults',
        'PORT=3000',
        '',
        '# optional',
        'DEBUG=',
        '',
      ].join('\n'),
    );
  });

  it('skips empty groups cleanly', () => {
    const out = formatEnvExample({
      ONLY: string().default('x'),
    });
    expect(out).toBe(['# with defaults', 'ONLY=x', ''].join('\n'));
  });

  it('preserves insertion order within each group', () => {
    const out = formatEnvExample({
      B: string(),
      A: string(),
      C: string(),
    });
    const idxB = out.indexOf('\nB=');
    const idxA = out.indexOf('\nA=');
    const idxC = out.indexOf('\nC=');
    expect(idxB).toBeLessThan(idxA);
    expect(idxA).toBeLessThan(idxC);
  });

  it('serializes boolean and number defaults as bare strings', () => {
    const out = formatEnvExample({
      FEATURE_FLAG: boolean().default(false),
      PORT: number().default(8080),
    });
    expect(out).toContain('FEATURE_FLAG=false');
    expect(out).toContain('PORT=8080');
  });

  it('handles empty schema (empty body)', () => {
    expect(formatEnvExample({})).toBe('');
  });
});

describe('applyMarkerBlock', () => {
  const body = formatEnvExample({
    STRIPE_KEY: string(),
    PORT: number().default(3000),
  });

  it('creates a fresh file with markers when none exists', () => {
    const result = applyMarkerBlock(null, body);
    expect(result.action).toBe('create');
    const lines = result.content.split('\n');
    expect(lines[0]).toBe(ENV_EXAMPLE_START_MARKER);
    // Trailing newline → last entry of split is "".
    expect(lines.at(-2)).toBe(ENV_EXAMPLE_END_MARKER);
    expect(result.content).toContain('STRIPE_KEY=');
    expect(result.content).toContain('PORT=3000');
  });

  it('replaces only the managed block, preserving lines above and below', () => {
    const existing = [
      '# Custom CI key — do not remove',
      'CI_TOKEN=abc123',
      '',
      ENV_EXAMPLE_START_MARKER,
      '# Run `void env example` to refresh.',
      '# required',
      'OLD_KEY=',
      ENV_EXAMPLE_END_MARKER,
      '',
      '# Custom build flag',
      'BUILD_VARIANT=fast',
      '',
    ].join('\n');

    const result = applyMarkerBlock(existing, body);
    expect(result.action).toBe('replace');
    expect(result.content).toContain('# Custom CI key — do not remove');
    expect(result.content).toContain('CI_TOKEN=abc123');
    expect(result.content).toContain('# Custom build flag');
    expect(result.content).toContain('BUILD_VARIANT=fast');
    // Old managed key is gone, new ones are present.
    expect(result.content).not.toContain('OLD_KEY=');
    expect(result.content).toContain('STRIPE_KEY=');
    expect(result.content).toContain('PORT=3000');

    // Pre-block content is verbatim.
    expect(result.content.startsWith('# Custom CI key — do not remove\nCI_TOKEN=abc123\n\n')).toBe(
      true,
    );
    // Post-block content is verbatim.
    expect(result.content.endsWith('\n\n# Custom build flag\nBUILD_VARIANT=fast\n')).toBe(true);
  });

  it('appends the block when no markers are present', () => {
    const existing = ['# Existing CI config', 'CI_TOKEN=abc', ''].join('\n');
    const result = applyMarkerBlock(existing, body);
    expect(result.action).toBe('append');
    // Original content stays at the top, verbatim.
    expect(result.content.startsWith('# Existing CI config\nCI_TOKEN=abc\n\n')).toBe(true);
    // Block follows.
    expect(result.content).toContain(ENV_EXAMPLE_START_MARKER);
    expect(result.content).toContain(ENV_EXAMPLE_END_MARKER);
    expect(result.content).toContain('STRIPE_KEY=');
    // Exactly one blank line separator between original content and the marker.
    const startIdx = result.content.indexOf(ENV_EXAMPLE_START_MARKER);
    expect(result.content.slice(0, startIdx)).toBe('# Existing CI config\nCI_TOKEN=abc\n\n');
  });

  it('returns an error when only the start marker is present', () => {
    const existing = ['CI_TOKEN=abc', ENV_EXAMPLE_START_MARKER, '# required', 'STRIPE_KEY='].join(
      '\n',
    );
    const result = applyMarkerBlock(existing, body);
    expect(result.action).toBe('error');
    expect(result.reason).toMatch(/end marker/i);
    expect(result.content).toBe(existing);
  });

  it('returns an error when only the end marker is present', () => {
    const existing = ['CI_TOKEN=abc', '# required', 'STRIPE_KEY=', ENV_EXAMPLE_END_MARKER].join(
      '\n',
    );
    const result = applyMarkerBlock(existing, body);
    expect(result.action).toBe('error');
    expect(result.reason).toMatch(/start marker/i);
    expect(result.content).toBe(existing);
  });

  it('is idempotent: running twice produces identical output', () => {
    const first = applyMarkerBlock(null, body).content;
    const second = applyMarkerBlock(first, body).content;
    expect(second).toBe(first);
    const third = applyMarkerBlock(second, body).content;
    expect(third).toBe(second);
  });

  it('appends cleanly even when the existing file lacks a trailing newline', () => {
    const existing = '# Existing\nCI_TOKEN=abc';
    const result = applyMarkerBlock(existing, body);
    expect(result.action).toBe('append');
    expect(result.content.startsWith('# Existing\nCI_TOKEN=abc\n\n')).toBe(true);
    expect(result.content.endsWith('\n')).toBe(true);
    expect(result.content).toContain(ENV_EXAMPLE_START_MARKER);
    expect(result.content).toContain(ENV_EXAMPLE_END_MARKER);
  });

  it('tolerates trailing whitespace on marker lines when matching', () => {
    const existing = [
      'CI_TOKEN=abc',
      `${ENV_EXAMPLE_START_MARKER}   `,
      '# Run `void env example` to refresh.',
      '# required',
      'OLD=',
      `${ENV_EXAMPLE_END_MARKER}\t`,
      'BUILD_VARIANT=fast',
    ].join('\n');
    const result = applyMarkerBlock(existing, body);
    expect(result.action).toBe('replace');
    expect(result.content).toContain('CI_TOKEN=abc');
    expect(result.content).toContain('BUILD_VARIANT=fast');
    expect(result.content).not.toContain('OLD=');
    expect(result.content).toContain('STRIPE_KEY=');
  });
});
