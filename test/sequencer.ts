import type { BaseSequencer, TestSpecification, Vitest } from 'vite-plus/test/node';
import { integrationTimings } from './integration-timings.ts';
import { balanceTests, compareKeys, shuffleTests, testFileKey } from './test-sharding.ts';

/** Balance integration work by cost, rather than by a hash of the filename. */
export class SuiteSequencer {
  private readonly ctx: Vitest;
  private baseSequencer: BaseSequencer | undefined;

  constructor(ctx: Vitest) {
    this.ctx = ctx;
  }

  private async base(): Promise<BaseSequencer> {
    // The config is also loaded by ordinary build commands. Only the test
    // runner needs to pay the startup cost of importing Vitest's Node API.
    this.baseSequencer ??= new (await import('vite-plus/test/node')).BaseSequencer(this.ctx);
    return this.baseSequencer;
  }
  private key(test: TestSpecification): string {
    return testFileKey(test.moduleId, this.ctx.config.root);
  }

  private duration(test: TestSpecification): number {
    return integrationTimings[this.key(test)] ?? 5000;
  }

  async shard(tests: Array<TestSpecification>): Promise<Array<TestSpecification>> {
    const shard = this.ctx.config.shard;
    if (!shard || tests.some((test) => test.project.name !== 'parallel-integration')) {
      return (await this.base()).shard(tests);
    }
    return balanceTests(
      tests,
      shard.count,
      (test) => this.key(test),
      (test) => this.duration(test),
    )[shard.index - 1];
  }

  async sort(tests: Array<TestSpecification>): Promise<Array<TestSpecification>> {
    const sequence = this.ctx.config.sequence;
    if (sequence.shuffle) {
      const stable = [...tests].sort((a, b) =>
        compareKeys(`${a.project.name}:${this.key(a)}`, `${b.project.name}:${this.key(b)}`),
      );
      return shuffleTests(stable, sequence.seed);
    }
    const sorted = await (await this.base()).sort(tests);
    if (!this.ctx.config.shard) {
      return sorted;
    }
    // Keep Vitest's cached ordering for other projects. The cold CI integration
    // pool needs measured estimates: a short source file can boot Angular.
    const integrations = sorted
      .filter((test) => test.project.name === 'parallel-integration')
      .sort((a, b) => this.duration(b) - this.duration(a) || compareKeys(this.key(a), this.key(b)));
    let index = 0;
    return sorted.map((test) =>
      test.project.name === 'parallel-integration' ? integrations[index++] : test,
    );
  }
}
