import { defineHandler, type InferProps } from 'void';
import { revalidate as reval } from 'void/isr';
import { kv } from 'void/kv';

export type Props = InferProps<typeof loader>;

export const revalidate = 60;

export const loader = defineHandler(async () => {
  const lastRevalidation = await kv.get('revalidate:last');
  return {
    lastRevalidation,
    renderedAt: new Date().toISOString(),
  };
});

export const action = defineHandler(async () => {
  try {
    await reval({ paths: ['/revalidate'] });
  } catch (err) {
    console.error('revalidate() failed:', err);
  }
  await kv.put('revalidate:last', new Date().toISOString());
});
