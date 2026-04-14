import { describe, expect, it } from 'vitest';
import { runValidation, type ValidatorSlots } from '../../src/runtime/validator';
import type { StandardSchemaV1 } from '../../src/standard-schema';

/** Create a mock Standard Schema that always succeeds with the given value. */
function mockSchema<T>(output: T): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value: unknown) {
        return { value: output ?? (value as T) };
      },
    },
  };
}

/** Create a mock Standard Schema that always fails with the given issues. */
function failSchema(issues: StandardSchemaV1.Issue[]): StandardSchemaV1 {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate() {
        return { issues };
      },
    },
  };
}

/** Create a minimal mock CloudContext. */
function mockContext(options: {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}): any {
  const url = new URL('http://localhost/test');
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      url.searchParams.set(key, value);
    }
  }
  return {
    req: {
      param: () => options.params ?? {},
      url: url.toString(),
      json: async () => {
        if (options.body === undefined) {
          throw new Error('No body');
        }
        return options.body;
      },
    },
  };
}

describe('runValidation', () => {
  it('validates body successfully', async () => {
    const validators: ValidatorSlots = {
      body: mockSchema({ name: 'Alice' }),
    };
    const c = mockContext({ body: { name: 'Alice' } });
    const result = await runValidation(validators, c);

    expect(result.ok).toBe(true);
    expect((result as any).input.body).toEqual({ name: 'Alice' });
  });

  it('validates query successfully', async () => {
    const validators: ValidatorSlots = {
      query: mockSchema({ page: '1' }),
    };
    const c = mockContext({ query: { page: '1' } });
    const result = await runValidation(validators, c);

    expect(result.ok).toBe(true);
    expect((result as any).input.query).toEqual({ page: '1' });
  });

  it('validates params successfully', async () => {
    const validators: ValidatorSlots = {
      params: mockSchema({ id: '42' }),
    };
    const c = mockContext({ params: { id: '42' } });
    const result = await runValidation(validators, c);

    expect(result.ok).toBe(true);
    expect((result as any).input.params).toEqual({ id: '42' });
  });

  it('validates multiple slots', async () => {
    const validators: ValidatorSlots = {
      params: mockSchema({ id: '1' }),
      body: mockSchema({ name: 'Bob' }),
    };
    const c = mockContext({ params: { id: '1' }, body: { name: 'Bob' } });
    const result = await runValidation(validators, c);

    expect(result.ok).toBe(true);
    expect((result as any).input.params).toEqual({ id: '1' });
    expect((result as any).input.body).toEqual({ name: 'Bob' });
  });

  it('returns 400 on body validation failure', async () => {
    const validators: ValidatorSlots = {
      body: failSchema([{ message: 'name is required' }]),
    };
    const c = mockContext({ body: {} });
    const result = await runValidation(validators, c);

    expect(result.ok).toBe(false);
    const response = (result as any).response as Response;
    expect(response.status).toBe(400);
    const json: any = await response.json();
    expect(json.error).toBe('Validation failed');
    expect(json.issues[0].slot).toBe('body');
  });

  it('returns 400 on invalid JSON body', async () => {
    const validators: ValidatorSlots = {
      body: mockSchema(null),
    };
    const c = mockContext({});
    const result = await runValidation(validators, c);

    expect(result.ok).toBe(false);
    const response = (result as any).response as Response;
    expect(response.status).toBe(400);
    const json: any = await response.json();
    expect(json.error).toBe('Invalid JSON body');
  });

  it('passes with empty validators', async () => {
    const c = mockContext({});
    const result = await runValidation({}, c);
    expect(result.ok).toBe(true);
  });

  it('includes path in flattened issues', async () => {
    const validators: ValidatorSlots = {
      body: failSchema([{ message: 'too short', path: [{ key: 'name' }] }]),
    };
    const c = mockContext({ body: { name: '' } });
    const result = await runValidation(validators, c);

    expect(result.ok).toBe(false);
    const response = (result as any).response as Response;
    const json: any = await response.json();
    expect(json.issues[0].issues[0].path).toBe('name');
  });
});
