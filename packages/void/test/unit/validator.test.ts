import { describe, expect, it } from 'vitest';
import type { CloudContext } from '../../src/runtime/handler.ts';
import { runValidation, type ValidatorSlots } from '../../src/runtime/validator.ts';
import type { StandardSchemaV1 } from '../../src/standard-schema.ts';

type ValidationIssueBody = {
  error: string;
  issues: Array<{
    slot: string;
    issues: Array<{ message: string; path?: string }>;
  }>;
};

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
function failSchema(issues: Array<StandardSchemaV1.Issue>): StandardSchemaV1 {
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
}): CloudContext {
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
  } as unknown as CloudContext;
}

describe('runValidation', () => {
  it('validates body successfully', async () => {
    const validators = {
      body: mockSchema({ name: 'Alice' }),
    } satisfies ValidatorSlots;
    const c = mockContext({ body: { name: 'Alice' } });
    const result = await runValidation(validators, c);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.body).toEqual({ name: 'Alice' });
    }
  });

  it('validates query successfully', async () => {
    const validators = {
      query: mockSchema({ page: '1' }),
    } satisfies ValidatorSlots;
    const c = mockContext({ query: { page: '1' } });
    const result = await runValidation(validators, c);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.query).toEqual({ page: '1' });
    }
  });

  it('validates params successfully', async () => {
    const validators = {
      params: mockSchema({ id: '42' }),
    } satisfies ValidatorSlots;
    const c = mockContext({ params: { id: '42' } });
    const result = await runValidation(validators, c);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.params).toEqual({ id: '42' });
    }
  });

  it('validates multiple slots', async () => {
    const validators = {
      params: mockSchema({ id: '1' }),
      body: mockSchema({ name: 'Bob' }),
    } satisfies ValidatorSlots;
    const c = mockContext({ params: { id: '1' }, body: { name: 'Bob' } });
    const result = await runValidation(validators, c);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.params).toEqual({ id: '1' });
      expect(result.input.body).toEqual({ name: 'Bob' });
    }
  });

  it('returns 400 on body validation failure', async () => {
    const validators: ValidatorSlots = {
      body: failSchema([{ message: 'name is required' }]),
    };
    const c = mockContext({ body: {} });
    const result = await runValidation(validators, c);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const json = (await result.response.json()) as ValidationIssueBody;
      expect(json.error).toBe('Validation failed');
      expect(json.issues[0].slot).toBe('body');
    }
  });

  it('returns 400 on invalid JSON body', async () => {
    const validators: ValidatorSlots = {
      body: mockSchema(null),
    };
    const c = mockContext({});
    const result = await runValidation(validators, c);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const json = (await result.response.json()) as { error: string };
      expect(json.error).toBe('Invalid JSON body');
    }
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
    if (!result.ok) {
      const json = (await result.response.json()) as ValidationIssueBody;
      expect(json.issues[0].issues[0].path).toBe('name');
    }
  });
});
