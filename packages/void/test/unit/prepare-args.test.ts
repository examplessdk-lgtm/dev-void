import { describe, expect, it } from 'vite-plus/test';
import { parsePrepareArgs } from '../../src/cli/prepare-args.ts';

describe('parsePrepareArgs', () => {
  it('accepts no arguments', () => {
    expect(() => parsePrepareArgs([])).not.toThrow();
  });

  it('rejects unexpected positional arguments', () => {
    expect(() => parsePrepareArgs(['extra'])).toThrow("prepare: Unexpected argument 'extra'.");
  });
});
