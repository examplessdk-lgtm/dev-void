import { describe, expect, it } from 'vite-plus/test';
import { releasePolicy } from '../../../../.github/scripts/release-policy.ts';

describe('public package release policy', () => {
  it.each([
    ['0.11.0', 'latest'],
    ['0.11.0-beta.1', 'beta'],
    ['0.11.0-rc.2', 'rc'],
    ['0.11.0-1', 'next'],
    ['0.11.0-latest.1', 'next'],
  ])('publishes %s only to %s', (version, npmTag) => {
    expect(
      releasePolicy(`v${version}`, [
        { name: 'void', version },
        { name: '@void/platform', version },
      ]),
    ).toEqual({ version, npmTag });
  });

  it.each(['v0.1.0', 'v3.0.1'])('rejects the unavailable version %s', (tag) => {
    expect(() => releasePolicy(tag, [{ name: 'void', version: tag.slice(1) }])).toThrow(
      'cannot be reused',
    );
  });

  it.each(['latest', 'v01.2.3', 'v1.2.3-beta.01', 'v1.2.3\nother=tag', 'v1.2.3\n', 'v1.2.3+build'])(
    'rejects malformed release tag %s',
    (tag) => {
      expect(() => releasePolicy(tag, [])).toThrow('exact semantic version');
    },
  );

  it('rejects mismatched CLI, scaffolder, adapter, or runtime versions', () => {
    expect(() =>
      releasePolicy('v0.11.0-beta.1', [
        { name: 'void', version: '0.11.0-beta.1' },
        { name: 'create-void', version: '0.10.14' },
      ]),
    ).toThrow('create-void@0.10.14 does not match');
  });
});
