import { describe, expect, it } from 'vite-plus/test';
import { integrationTimings } from '../../../../test/integration-timings.ts';
import { balanceTests, shuffleTests, testFileKey } from '../../../../test/test-sharding.ts';

describe('integration test scheduling', () => {
  it('preserves seeded shuffle without changing membership or the input', () => {
    const files = Object.keys(integrationTimings);
    const original = [...files];
    expect(shuffleTests(files, 42)).toEqual(shuffleTests(files, 42));
    expect(shuffleTests(files, 42)).not.toEqual(shuffleTests(files, 43));
    expect(shuffleTests(files, 42).sort()).toEqual([...files].sort());
    expect(files).toEqual(original);
  });
  it.each([1, 2, 3, 50])(
    'assigns every known and newly added file exactly once across %i shards',
    (count) => {
      const files = [
        ...Object.keys(integrationTimings),
        'packages/void/test/integration/new.test.ts',
      ];
      const original = [...files];
      const shards = balanceTests(
        files,
        count,
        (file) => file,
        (file) => integrationTimings[file] ?? 5000,
      );
      expect(shards).toHaveLength(count);
      expect(shards.flat().sort()).toEqual([...files].sort());
      expect(new Set(shards.flat()).size).toBe(files.length);
      expect(files).toEqual(original);
    },
  );

  it('is independent of discovery order and checkout path', () => {
    const files = Object.keys(integrationTimings);
    const posix = files.map((file) => `/work/repo/${file}`);
    const windows = [...files]
      .reverse()
      .map((file) => `D:\\a\\repo\\${file.replaceAll('/', '\\')}`);
    const plan = (items: Array<string>, root: string) =>
      balanceTests(
        items,
        2,
        (file) => testFileKey(file, root),
        (file) => integrationTimings[testFileKey(file, root)],
      ).map((shard) => shard.map((file) => testFileKey(file, root)));
    expect(plan(posix, '/work/repo')).toEqual(plan(windows, 'D:\\a\\repo'));
  });

  it('keeps the measured two-shard load balanced', () => {
    const files = Object.keys(integrationTimings);
    const shards = balanceTests(
      files,
      2,
      (file) => file,
      (file) => integrationTimings[file],
    );
    const loads = shards.map((shard) =>
      shard.reduce((total, file) => total + integrationTimings[file], 0),
    );
    expect(Math.max(...loads) / Math.min(...loads)).toBeLessThan(1.05);
  });

  it.each([0, -1, 1.5])('rejects invalid shard count %s', (count) => {
    expect(() => balanceTests([], count, String, () => 1)).toThrow('positive integer');
  });
});
