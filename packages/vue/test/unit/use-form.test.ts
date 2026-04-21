import { describe, expect, it } from 'vitest';
import { isEqualFormValue } from 'void/pages-client';
import { reactive, ref, isReactive, isRef, nextTick, watch } from 'vue';

// Test the reactive logic of useForm directly (without Vue app context).
// We re-implement the core logic inline since useForm uses inject() which
// requires a Vue app. The actual integration is tested in the playground.

describe('useForm reactive logic', () => {
  type FormData = Record<string, unknown>;

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

    const data = reactive({ ...formDefaults }) as FormData;
    const errors = reactive<Record<string, string>>({});
    const pending = ref(false);
    const wasSuccessful = ref(false);
    const recentlySuccessful = ref(false);

    const defaults_ = { ...formDefaults };

    const hasChanges = ref(false);
    watch(
      () => ({ ...data }),
      (val) => {
        hasChanges.value = Object.keys(defaults_).some(
          (key) => !isEqualFormValue(val[key], defaults_[key]),
        );
      },
      { deep: true },
    );

    function reset(...fields: string[]) {
      if (fields.length === 0) {
        Object.assign(data, { ...defaults_ });
      } else {
        for (const field of fields) {
          data[field] = defaults_[field];
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
      pending,
      hasChanges,
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
    form.data.name = 'John';
    expect(form.data.name).toBe('John');
  });

  it('hasChanges becomes true when data changes', async () => {
    const form = createForm('/test', { name: 'default' });
    expect(form.hasChanges.value).toBe(false);

    form.data.name = 'changed';
    await nextTick();

    expect(form.hasChanges.value).toBe(true);
  });

  it('hasChanges becomes false when data reverts to defaults', async () => {
    const form = createForm('/test', { name: 'default' });
    form.data.name = 'changed';
    await nextTick();
    expect(form.hasChanges.value).toBe(true);

    form.data.name = 'default';
    await nextTick();
    expect(form.hasChanges.value).toBe(false);
  });

  it('hasChanges treats equal arrays and plain objects as clean', async () => {
    const form = createForm('/test', {
      meta: { enabled: true, nested: { count: 1 } },
      tags: ['one'],
    });

    form.data.tags = ['one', 'two'];
    form.data.meta = { enabled: false, nested: { count: 2 } };
    await nextTick();
    expect(form.hasChanges.value).toBe(true);

    form.data.tags = ['one'];
    form.data.meta = { nested: { count: 1 }, enabled: true };
    await nextTick();
    expect(form.hasChanges.value).toBe(false);
  });

  it('hasChanges keeps Object.is semantics for primitive edge cases', async () => {
    const form = createForm('/test', { count: NaN, zero: -0 });

    form.data.count = NaN;
    await nextTick();
    expect(form.hasChanges.value).toBe(false);

    form.data.zero = 0;
    await nextTick();
    expect(form.hasChanges.value).toBe(true);
  });

  it('hasChanges compares non-plain objects by reference', async () => {
    const startedAt = new Date(0);
    const form = createForm('/test', { startedAt });

    form.data.startedAt = new Date(0);
    await nextTick();

    expect(form.hasChanges.value).toBe(true);
  });

  it('reset() reverts all fields to defaults', async () => {
    const form = createForm('/test', { name: 'default', email: 'default@test.com' });
    form.data.name = 'changed';
    form.data.email = 'changed@test.com';

    form.reset();

    expect(form.data.name).toBe('default');
    expect(form.data.email).toBe('default@test.com');
    await nextTick();
    expect(form.hasChanges.value).toBe(false);
  });

  it('reset(field) reverts specific fields only', () => {
    const form = createForm('/test', { name: 'default', email: 'default@test.com' });
    form.data.name = 'changed';
    form.data.email = 'changed@test.com';

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

  it('pending is a ref initialized to false', () => {
    const form = createForm('/test', { name: '' });
    expect(isRef(form.pending)).toBe(true);
    expect(form.pending.value).toBe(false);
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
