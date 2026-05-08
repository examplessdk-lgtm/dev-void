import { describe, expect, it } from 'vite-plus/test';
import { isEqualFormValue } from 'void/pages-client';

// Test the core logic of useForm directly (without Solid rendering context).
// We re-implement the non-hook logic inline since useForm uses useContext/createStore
// which require a Solid component tree. Actual integration is tested in the playground.

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
    const pending = false;
    const wasSuccessful = false;
    const recentlySuccessful = false;

    const defaults_ = { ...formDefaults };

    function hasChanges() {
      return Object.keys(defaults_).some((key) => !isEqualFormValue(data[key], defaults_[key]));
    }

    function setData(field: string, value: unknown) {
      data = { ...data, [field]: value };
    }

    function reset(...fields: Array<string>) {
      if (fields.length === 0) {
        data = { ...defaults_ };
      } else {
        data = { ...data };
        for (const field of fields) {
          data[field] = defaults_[field];
        }
      }
    }

    function clearErrors(...fields: Array<string>) {
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
      get pending() {
        return pending;
      },
      get wasSuccessful() {
        return wasSuccessful;
      },
      get recentlySuccessful() {
        return recentlySuccessful;
      },
      hasChanges,
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

  it('hasChanges returns true when data changes', () => {
    const form = createForm('/test', { name: 'default' });
    expect(form.hasChanges()).toBe(false);

    form.setData('name', 'changed');
    expect(form.hasChanges()).toBe(true);
  });

  it('hasChanges returns false when data reverts to defaults', () => {
    const form = createForm('/test', { name: 'default' });
    form.setData('name', 'changed');
    expect(form.hasChanges()).toBe(true);

    form.setData('name', 'default');
    expect(form.hasChanges()).toBe(false);
  });

  it('hasChanges treats equal arrays and plain objects as clean', () => {
    const form = createForm('/test', {
      meta: { enabled: true, nested: { count: 1 } },
      tags: ['one'],
    });

    form.setData('tags', ['one', 'two']);
    form.setData('meta', { enabled: false, nested: { count: 2 } });
    expect(form.hasChanges()).toBe(true);

    form.setData('tags', ['one']);
    form.setData('meta', { nested: { count: 1 }, enabled: true });
    expect(form.hasChanges()).toBe(false);
  });

  it('hasChanges keeps Object.is semantics for primitive edge cases', () => {
    const form = createForm('/test', { count: NaN, zero: -0 });

    form.setData('count', NaN);
    expect(form.hasChanges()).toBe(false);

    form.setData('zero', 0);
    expect(form.hasChanges()).toBe(true);
  });

  it('hasChanges compares non-plain objects by reference', () => {
    const startedAt = new Date(0);
    const form = createForm('/test', { startedAt });

    form.setData('startedAt', new Date(0));

    expect(form.hasChanges()).toBe(true);
  });

  it('reset() reverts all fields to defaults', () => {
    const form = createForm('/test', { name: 'default', email: 'default@test.com' });
    form.setData('name', 'changed');
    form.setData('email', 'changed@test.com');

    form.reset();

    expect(form.data.name).toBe('default');
    expect(form.data.email).toBe('default@test.com');
    expect(form.hasChanges()).toBe(false);
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

  it('pending is initialized to false', () => {
    const form = createForm('/test', { name: '' });
    expect(form.pending).toBe(false);
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
