import { defineHandler } from 'void';
import { ai, type ThirdPartyModel } from 'void/ai';

export const POST = defineHandler(async (c) => {
  const { prompt, model } = await c.req.json<{
    prompt: string;
    model: string;
  }>();

  try {
    return ai.stream(model as ThirdPartyModel, {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 512,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
});
