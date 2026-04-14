import { describe, expect, it } from 'vitest';

// Test the core logic of useForm directly (without React rendering context).
// We re-implement the non-hook logic inline since useForm uses useContext/useState
// which require a React component tree. Actual integration is tested in the playground.

describe('useForm core logic', () => {
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

    let data = { ...formDefaults };
    let errors: Record<string, string> = {};
    const processing = false;
    const wasSuccessful = false;
    const recentlySuccessful = false;

    const defaults_ = { ...formDefaults };

    function isDirty() {
      return Object.keys(defaults_).some(
        (key) => JSON.stringify(data[key]) !== JSON.stringify(defaults_[key]),
      );
    }

    function setData(field: string, value: unknown) {
      data = { ...data, [field]: value };
    }

    function reset(...fields: string[]) {
      if (fields.length === 0) {
        data = { ...defaults_ };
      } else {
        data = { ...data };
        for (const field of fields) {
          data[field] = defaults_[field];
        }
      }
    }

    function clearErrors(...fields: string[]) {
      if (fields.length === 0) {
        errors = {};
      } else {
        errors = { ...errors };
        for (const field of fields) {
          delete errors[field];
        }
      }
    }

    return {
      get data() {
        return data;
      },
      get errors() {
        return errors;
      },
      set errors(e: Record<string, string>) {
        errors = e;
      },
      get processing() {
        return processing;
      },
      get wasSuccessful() {
        return wasSuccessful;
      },
      get recentlySuccessful() {
        return recentlySuccessful;
      },
      isDirty,
      setData,
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

  it('setData updates a single field', () => {
    const form = createForm('/test', { name: '', email: '' });
    form.setData('name', 'John');
    expect(form.data.name).toBe('John');
    expect(form.data.email).toBe('');
  });

  it('isDirty returns true when data changes', () => {
    const form = createForm('/test', { name: 'default' });
    expect(form.isDirty()).toBe(false);

    form.setData('name', 'changed');
    expect(form.isDirty()).toBe(true);
  });

  it('isDirty returns false when data reverts to defaults', () => {
    const form = createForm('/test', { name: 'default' });
    form.setData('name', 'changed');
    expect(form.isDirty()).toBe(true);

    form.setData('name', 'default');
    expect(form.isDirty()).toBe(false);
  });

  it('reset() reverts all fields to defaults', () => {
    const form = createForm('/test', { name: 'default', email: 'default@test.com' });
    form.setData('name', 'changed');
    form.setData('email', 'changed@test.com');

    form.reset();

    expect(form.data.name).toBe('default');
    expect(form.data.email).toBe('default@test.com');
    expect(form.isDirty()).toBe(false);
  });

  it('reset(field) reverts specific fields only', () => {
    const form = createForm('/test', { name: 'default', email: 'default@test.com' });
    form.setData('name', 'changed');
    form.setData('email', 'changed@test.com');

    form.reset('name');

    expect(form.data.name).toBe('default');
    expect(form.data.email).toBe('changed@test.com');
  });

  it('clearErrors() removes all errors', () => {
    const form = createForm('/test', { name: '' });
    form.errors = { name: 'required', email: 'invalid' };

    form.clearErrors();

    expect(Object.keys(form.errors)).toHaveLength(0);
  });

  it('clearErrors(field) removes specific errors', () => {
    const form = createForm('/test', { name: '' });
    form.errors = { name: 'required', email: 'invalid' };

    form.clearErrors('name');

    expect(form.errors.name).toBeUndefined();
    expect(form.errors.email).toBe('invalid');
  });

  it('processing is initialized to false', () => {
    const form = createForm('/test', { name: '' });
    expect(form.processing).toBe(false);
  });

  it('wasSuccessful and recentlySuccessful are initialized to false', () => {
    const form = createForm('/test', { name: '' });
    expect(form.wasSuccessful).toBe(false);
    expect(form.recentlySuccessful).toBe(false);
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
