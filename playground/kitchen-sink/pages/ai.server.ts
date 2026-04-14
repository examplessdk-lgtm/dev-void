import { defineHandler, type InferProps } from 'void';

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(() => {
  return {
    models: [
      {
        value: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        label: 'Llama 3.3 70B (Workers AI)',
      },
      { value: 'openai/gpt-4o', label: 'GPT-4o (OpenAI)' },
      {
        value: 'anthropic/claude-sonnet-4-20250514',
        label: 'Claude Sonnet 4 (Anthropic)',
      },
    ],
  };
});
