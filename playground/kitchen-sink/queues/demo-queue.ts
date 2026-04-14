import { defineQueue } from 'void';

export const maxBatchTimeout = 1;

export default defineQueue<{ key: string; value: string }>(async (batch, env) => {
  for (const msg of batch.messages) {
    await env.DB.prepare('INSERT INTO queue_results (key, value) VALUES (?, ?)')
      .bind(msg.body.key, msg.body.value)
      .run();
  }
});
