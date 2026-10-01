export const queueCases = [
  'ack',
  'retry-once',
  'throw-once',
  'ack-then-retry',
  'retry-then-ack',
  'batch-ack-then-retry',
  'batch-retry-then-ack',
] as const;

export type QueueCase = (typeof queueCases)[number];
export type AcceptanceMessage = { run: string; scenario: QueueCase };
export const queueResultKey = (run: string) => `runtime-queue:${run}`;

export function validQueueRun(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{16}$/.test(value);
}
