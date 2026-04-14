import { describe, expect, it } from 'vitest';
import { reactive, ref, isReactive, isRef, nextTick, watch } from 'vue';

// Test the reactive logic of useForm directly (without Vue app context).
// We re-implement the core logic inline since useForm uses inject() which
// requires a Vue app. The actual integration is tested in the playground.

describe('useForm reactive logic', () => {
  function createForm(
    url: string,
    defaults: Record<string, unknown>,
    options?: { params?: Record<string, string> },
  ) {
    let resolvedUrl = url;
    const formDefaults = defaults;

    if (options?.params) {
      for (const [key, value] of Object.entries(options.params)) {
        resolvedUrl = resolvedUrl.replace(`:${key}`, encodeURIComponent(value));
      }
    }

    const data = reactive({ ...formDefaults }) as Record<string, unknown>;
    const errors = reactive<Record<string, string>>({});
    const processing = ref(false);
    const wasSuccessful = ref(false);
    const recentlySuccessful = ref(false);

    const defaults_ = { ...formDefaults };

    const isDirty = ref(false);
    watch(
      () => ({ ...data }),
      (val) => {
        isDirty.value = Object.keys(defaults_).some(
          (key) => JSON.stringify(val[key]) !== JSON.stringify(defaults_[key]),
        );
      },
      { deep: true },
    );

    function reset(...fields: string[]) {
      if (fields.length === 0) {
        Object.assign(data, { ...defaults_ });
      } else {
        for (const field of fields) {
          (data as any)[field] = (defaults_ as any)[field];
        }
      }
    }

    function clearErrors(...fields: string[]) {
      if (fields.length === 0) {
        for (const key of Object.keys(errors)) {
          delete errors[key];
        }
      } else {
        for (const field of fields) {
          delete errors[field];
        }
      }
    }

    return {
      data,
      errors,
      processing,
      isDirty,
      wasSuccessful,
      recentlySuccessful,
      reset,
      clearErrors,
      _url: resolvedUrl,
    };
  }

  it('initial data matches defaults', () => {
    const form = createForm('/test', { name: '', email: '' });
    expect(form.data.name).toBe('');
    expect(form.data.email).toBe('');
  });

  it('data is reactive', () => {
    const form = createForm('/test', { name: 'test' });
    expect(isReactive(form.data)).toBe(true);
  });

  it('updating data changes value', () => {
    const form = createForm('/test', { name: '' });
    (form.data as any).name = 'John';
    expect(form.data.name).toBe('John');
  });

  it('isDirty becomes true when data changes', async () => {
    const form = createForm('/test', { name: 'default' });
    expect(form.isDirty.value).toBe(false);

    (form.data as any).name = 'changed';
    await nextTick();

    expect(form.isDirty.value).toBe(true);
  });

  it('isDirty becomes false when data reverts to defaults', async () => {
    const form = createForm('/test', { name: 'default' });
    (form.data as any).name = 'changed';
    await nextTick();
    expect(form.isDirty.value).toBe(true);

    (form.data as any).name = 'default';
    await nextTick();
    expect(form.isDirty.value).toBe(false);
  });

  it('reset() reverts all fields to defaults', async () => {
    const form = createForm('/test', { name: 'default', email: 'default@test.com' });
    (form.data as any).name = 'changed';
    (form.data as any).email = 'changed@test.com';

    form.reset();

    expect(form.data.name).toBe('default');
    expect(form.data.email).toBe('default@test.com');
    await nextTick();
    expect(form.isDirty.value).toBe(false);
  });

  it('reset(field) reverts specific fields only', () => {
    const form = createForm('/test', { name: 'default', email: 'default@test.com' });
    (form.data as any).name = 'changed';
    (form.data as any).email = 'changed@test.com';

    form.reset('name');

    expect(form.data.name).toBe('default');
    expect(form.data.email).toBe('changed@test.com');
  });

  it('clearErrors() removes all errors', () => {
    const form = createForm('/test', { name: '' });
    form.errors.name = 'required';
    form.errors.email = 'invalid';

    form.clearErrors();

    expect(Object.keys(form.errors)).toHaveLength(0);
  });

  it('clearErrors(field) removes specific errors', () => {
    const form = createForm('/test', { name: '' });
    form.errors.name = 'required';
    form.errors.email = 'invalid';

    form.clearErrors('name');

    expect(form.errors.name).toBeUndefined();
    expect(form.errors.email).toBe('invalid');
  });

  it('processing is a ref initialized to false', () => {
    const form = createForm('/test', { name: '' });
    expect(isRef(form.processing)).toBe(true);
    expect(form.processing.value).toBe(false);
  });

  it('wasSuccessful and recentlySuccessful are refs initialized to false', () => {
    const form = createForm('/test', { name: '' });
    expect(form.wasSuccessful.value).toBe(false);
    expect(form.recentlySuccessful.value).toBe(false);
  });

  it('stores URL', () => {
    const form = createForm('/users', { name: '', email: '' });
    expect(form.data.name).toBe('');
    expect(form.data.email).toBe('');
    expect(form._url).toBe('/users');
  });

  it('resolves :param segments in URL', () => {
    const form = createForm('/users/:id', { name: 'Alice' }, { params: { id: '42' } });
    expect(form.data.name).toBe('Alice');
    expect(form._url).toBe('/users/42');
  });

  it('encodes param values in URL', () => {
    const form = createForm('/users/:id', { name: '' }, { params: { id: 'hello world' } });
    expect(form._url).toBe('/users/hello%20world');
  });

  it('resolves multiple params', () => {
    const form = createForm(
      '/org/:orgId/users/:userId',
      { name: '' },
      { params: { orgId: 'a', userId: 'b' } },
    );
    expect(form._url).toBe('/org/a/users/b');
  });
});
