import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { logger } from '../../src/runtime/log.ts';

describe('runtime log', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logger.error calls console.error with stringified JSON', () => {
    logger.error('boom', { jobId: 'j1' });

    expect(console.error).toHaveBeenCalledTimes(1);
    const arg = (console.error as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(typeof arg).toBe('string');
    expect(JSON.parse(arg as string)).toEqual({ msg: 'boom', jobId: 'j1' });
  });

  it('logger.warn calls console.warn with stringified JSON', () => {
    logger.warn('careful', { reason: 'slow' });

    expect(console.warn).toHaveBeenCalledTimes(1);
    const arg = (console.warn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.parse(arg as string)).toEqual({ msg: 'careful', reason: 'slow' });
  });

  it('logger.info calls console.info with stringified JSON', () => {
    logger.info('hello', { user: 'alice' });

    expect(console.info).toHaveBeenCalledTimes(1);
    const arg = (console.info as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.parse(arg as string)).toEqual({ msg: 'hello', user: 'alice' });
  });

  it('JSON has msg as the first key, followed by fields', () => {
    logger.info('m', { a: 1, b: 2 });

    const arg = (console.info as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const parsed = JSON.parse(arg);
    expect(Object.keys(parsed)).toEqual(['msg', 'a', 'b']);
  });

  it('fields is optional — calling without fields works', () => {
    logger.error('lonely');

    const arg = (console.error as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(JSON.parse(arg)).toEqual({ msg: 'lonely' });
  });

  it('msg argument wins when fields contain a msg key (safer default — user intent in arg is preserved)', () => {
    // Rationale: the explicit `message` argument is the primary contract.
    // If a user accidentally passes `{ msg: ... }` in fields, dropping their
    // primary message would be a silent data loss. msg-wins keeps the
    // argument visible.
    logger.error('intended', { msg: 'sneaky', extra: 1 });

    const arg = (console.error as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(JSON.parse(arg)).toEqual({ msg: 'intended', extra: 1 });
  });

  it('a `toJSON` key in fields cannot hijack the output shape', () => {
    // Rationale: `JSON.stringify` calls `payload.toJSON()` if present and
    // serializes its return value instead of the object. If we copied a
    // user-supplied `toJSON` onto our payload, the user could replace the
    // entire emitted shape — dropping `msg` and faking an arbitrary `level`.
    // We skip the `toJSON` key during the field copy to preserve the
    // greppable `{ msg, ...fields }` contract.
    logger.info('visible', {
      toJSON: () => ({ level: 'error' }),
      x: 1,
    } as Record<string, unknown>);

    const arg = (console.info as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.msg).toBe('visible');
    expect(parsed.x).toBe(1);
    expect('toJSON' in parsed).toBe(false);
    // No phantom `level` key from the would-be hijack.
    expect('level' in parsed).toBe(false);
  });

  it('inherited enumerable keys from the prototype chain are not copied', () => {
    // Rationale: `for...in` walks the prototype chain. `Object.entries` does
    // not. The contract is "log the data the caller passed me", not "log
    // anything reachable from the caller's object". This makes the output
    // predictable for callers passing class instances or `Object.create(...)`
    // results.
    const parent = { inherited: 'should-not-appear' };
    const fields = Object.create(parent) as Record<string, unknown>;
    fields.own = 'should-appear';

    logger.info('proto', fields);

    const arg = (console.info as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.msg).toBe('proto');
    expect(parsed.own).toBe('should-appear');
    expect('inherited' in parsed).toBe(false);
  });

  it('function-valued fields are skipped deterministically', () => {
    // Rationale: `JSON.stringify` silently omits function values, so the
    // observable output is the same. Skipping explicitly keeps the
    // intent visible (and matches the `toJSON` exclusion above — both are
    // "no callable surface in the payload").
    logger.info('fn', {
      cb: () => 'nope',
      keep: 'yes',
    } as Record<string, unknown>);

    const arg = (console.info as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.msg).toBe('fn');
    expect(parsed.keep).toBe('yes');
    expect('cb' in parsed).toBe(false);
  });

  it('an own enumerable `__proto__` cannot hijack the output via prototype mutation', () => {
    // Rationale: writing `payload.__proto__ = value` on a plain `{}` invokes
    // the `Object.prototype.__proto__` setter and mutates the payload's
    // prototype. If the assigned value has a `toJSON` method, the payload
    // then inherits it and `JSON.stringify(payload)` calls it — letting the
    // attacker substitute the entire emitted shape. Building the payload
    // with `Object.create(null)` removes the setter entirely, turning
    // `payload.__proto__ = value` into a plain own-property write (which we
    // then skip explicitly for defense in depth).
    const fields = {} as Record<string, unknown>;
    Object.defineProperty(fields, '__proto__', {
      enumerable: true,
      configurable: true,
      writable: true,
      value: { toJSON: () => ({ msg: 'hacked', level: 'error' }) },
    });

    logger.info('visible', fields);

    const arg = (console.info as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.msg).toBe('visible');
    expect('level' in parsed).toBe(false);
  });

  it('throwing enumerable getters do not crash — fallback to safe shape', () => {
    // Rationale: `Object.entries(fields)` invokes enumerable getters during
    // enumeration. If a getter throws (or a proxy trap throws), the
    // logging call must catch it and emit the fallback shape rather than
    // propagating the error and breaking the caller's control flow
    // (typically an error-handling path).
    const fields = { ok: 1 } as Record<string, unknown>;
    Object.defineProperty(fields, 'bomb', {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error('boom');
      },
    });

    expect(() => logger.error('getter', fields)).not.toThrow();

    expect(console.error).toHaveBeenCalledTimes(1);
    const arg = (console.error as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.msg).toBe('getter');
    expect(parsed.error).toBe('log: fields not serializable');
  });

  it('a `constructor` key in fields is skipped', () => {
    // Rationale: defense in depth alongside the `__proto__` skip. A
    // `constructor` field on a normal object isn't dangerous on its own
    // (the payload uses `Object.create(null)` so there's nothing to
    // shadow), but skipping it keeps the field-copy loop's intent
    // consistent with `__proto__` and avoids surprises if the payload
    // construction ever changes.
    logger.info('ctor', { constructor: 'evil', keep: 'yes' });

    const arg = (console.info as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.msg).toBe('ctor');
    expect(parsed.keep).toBe('yes');
    // `JSON.parse` returns a plain object whose prototype already has
    // `constructor`, so check own-property only.
    expect(Object.hasOwn(parsed, 'constructor')).toBe(false);
  });

  it('non-stringifiable values (circular refs) do not crash — fallback to safe shape', () => {
    // Rationale: throwing inside a logger call would break user code paths
    // (often error-handling paths). Catching and emitting a safe fallback
    // is the simpler, less surprising behavior.
    const circular: Record<string, unknown> = { name: 'cycle' };
    circular.self = circular;

    expect(() => logger.error('circular failure', circular)).not.toThrow();

    expect(console.error).toHaveBeenCalledTimes(1);
    const arg = (console.error as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(typeof arg).toBe('string');
    // Must still be valid JSON containing the original msg.
    const parsed = JSON.parse(arg as string);
    expect(parsed.msg).toBe('circular failure');
  });
});
