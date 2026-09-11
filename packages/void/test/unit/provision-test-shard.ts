export type ProvisionTestShard =
  | 'resources'
  | 'locking'
  | 'lock-durability'
  | 'lock-recovery'
  | 'runner-signals'
  | 'runner-timeouts';

const shardKey = '__voidProvisionTestShard';
type ProvisionTestGlobal = typeof globalThis &
  Record<typeof shardKey, ProvisionTestShard | undefined>;

export async function runProvisionTestShard(shard: ProvisionTestShard): Promise<void> {
  (globalThis as ProvisionTestGlobal)[shardKey] = shard;
  await import('./provision.cases.ts');
}

export function getProvisionTestShard(): ProvisionTestShard {
  const shard = (globalThis as ProvisionTestGlobal)[shardKey];
  if (!shard) {
    throw new Error('Provision test cases must be loaded through a shard entrypoint');
  }
  return shard;
}
