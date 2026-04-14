import type { StandardSchemaV1 } from '../standard-schema';
import type { CloudContext } from './handler';

export interface ValidatorSlots {
  body?: StandardSchemaV1;
  query?: StandardSchemaV1;
  params?: StandardSchemaV1;
}

interface ValidationSuccess<V extends ValidatorSlots> {
  ok: true;
  input: HandlerInput<V>;
}

interface ValidationFailure {
  ok: false;
  response: Response;
}

export type HandlerInput<V extends ValidatorSlots> = {
  [K in keyof V as V[K] extends StandardSchemaV1 ? K : never]: V[K] extends StandardSchemaV1
    ? StandardSchemaV1.InferOutput<V[K]>
    : never;
};

function flattenIssues(
  issues: readonly StandardSchemaV1.Issue[],
): { message: string; path?: string }[] {
  return Array.from(issues, (issue) => ({
    message: issue.message,
    path: issue.path?.map((p) => (typeof p === 'object' ? p.key : p)).join('.'),
  }));
}

async function validateSlot(
  schema: StandardSchemaV1,
  value: unknown,
): Promise<
  { ok: true; value: unknown } | { ok: false; issues: readonly StandardSchemaV1.Issue[] }
> {
  const result = await schema['~standard'].validate(value);
  if (result.issues) {
    return { ok: false, issues: result.issues };
  }
  return { ok: true, value: result.value };
}

export async function runValidation<V extends ValidatorSlots>(
  validators: V,
  c: CloudContext,
): Promise<ValidationSuccess<V> | ValidationFailure> {
  const input: Record<string, unknown> = {};
  const allIssues: { slot: string; issues: readonly { message: string; path?: string }[] }[] = [];

  if (validators.params) {
    const raw = c.req.param() as Record<string, string>;
    const result = await validateSlot(validators.params, raw);
    if (result.ok) {
      input.params = result.value;
    } else {
      allIssues.push({ slot: 'params', issues: flattenIssues(result.issues) });
    }
  }

  if (validators.query) {
    const url = new URL(c.req.url);
    const raw: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      raw[key] = value;
    }
    const result = await validateSlot(validators.query, raw);
    if (result.ok) {
      input.query = result.value;
    } else {
      allIssues.push({ slot: 'query', issues: flattenIssues(result.issues) });
    }
  }

  if (validators.body) {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return {
        ok: false,
        response: Response.json({ error: 'Invalid JSON body' }, { status: 400 }),
      };
    }
    const result = await validateSlot(validators.body, raw);
    if (result.ok) {
      input.body = result.value;
    } else {
      allIssues.push({ slot: 'body', issues: flattenIssues(result.issues) });
    }
  }

  if (allIssues.length > 0) {
    return {
      ok: false,
      response: Response.json({ error: 'Validation failed', issues: allIssues }, { status: 400 }),
    };
  }

  return { ok: true, input: input as HandlerInput<V> };
}
