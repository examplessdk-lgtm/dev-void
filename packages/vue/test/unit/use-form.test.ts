import { describe, expect, it } from 'vite-plus/test';
import type { VoidRouter } from 'void/pages-client';
import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { useForm as typedUseForm } from '../../src/runtime/use-form.ts';

// The public overload only accepts generated action URLs; these tests use plain paths.
const useForm = typedUseForm as unknown as (
  url: string,
  defaults: Record<string, unknown>,
  options: { params: Record<string, string> },
) => { post(): Promise<void>; readonly pending: boolean };

async function renderForm(url: string, params: Record<string, string>) {
  const visits: Array<string> = [];
  const router = {
    visit: async (target: string) => {
      visits.push(target);
      return {};
    },
  } as unknown as VoidRouter;
  let form!: ReturnType<typeof useForm>;
  const app = createSSRApp(
    defineComponent({
      setup() {
        form = useForm(url, {}, { params });
        return () => h('form');
      },
    }),
  );
  app.provide('__void_router', router);
  // Rendering stays possible whatever the param holds; only a submit resolves it.
  await renderToString(app);
  return { form, visits };
}

describe('useForm params', () => {
  it('fills in params and keeps the action query', async () => {
    const { form, visits } = await renderForm('/users/:name/follow?action=follow', {
      name: 'a b/c',
    });
    await form.post();
    expect(visits).toEqual(['/users/a%20b%2Fc/follow?action=follow']);
  });

  it.each(['.', '..'])('refuses to submit when a param is %j', async (name) => {
    const { form, visits } = await renderForm('/users/:name/follow', { name });
    await expect(form.post()).rejects.toThrow(TypeError);
    expect(visits).toEqual([]);
    expect(form.pending).toBe(false);
  });
});
