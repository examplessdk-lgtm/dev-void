import { describe, expect, it } from 'vite-plus/test';
import {
  DEFAULT_VERSION_METADATA_BINDING,
  readVersionMetadataBinding,
  selectNativeVersionMetadataBinding,
} from '../../src/shared/version-metadata.ts';

const native = { nativeBuild: true, preserveBindings: false };

describe('native readiness metadata binding', () => {
  it('selects only self-metadata for ordinary native builds without mutating configuration', () => {
    const config = Object.freeze({});
    expect(selectNativeVersionMetadataBinding(config, native)).toBe(
      DEFAULT_VERSION_METADATA_BINDING,
    );
    expect(config).toEqual({});
  });

  it('leaves managed, development and ordinary Vite builds without an added binding', () => {
    expect(
      selectNativeVersionMetadataBinding({}, { nativeBuild: false, preserveBindings: false }),
    ).toBeUndefined();
  });

  it('does not add a binding while handing off an existing site', () => {
    expect(
      selectNativeVersionMetadataBinding({}, { ...native, preserveBindings: true }),
    ).toBeUndefined();
  });

  it.each([false, true])(
    'keeps the authored metadata name during handoff=%s',
    (preserveBindings) => {
      const config = { version_metadata: { binding: 'AUTHORED_VERSION' } };
      expect(selectNativeVersionMetadataBinding(config, { ...native, preserveBindings })).toBe(
        'AUTHORED_VERSION',
      );
      expect(config).toEqual({ version_metadata: { binding: 'AUTHORED_VERSION' } });
    },
  );

  it.each([
    { vars: { [DEFAULT_VERSION_METADATA_BINDING]: 'authored' } },
    { kv_namespaces: [{ binding: DEFAULT_VERSION_METADATA_BINDING, id: 'kv-id' }] },
    { queues: { producers: [{ binding: DEFAULT_VERSION_METADATA_BINDING, queue: 'jobs' }] } },
    { secrets: { required: [DEFAULT_VERSION_METADATA_BINDING] } },
  ])('rejects an occupied default name before upload: %j', (config) => {
    expect(() => selectNativeVersionMetadataBinding(config, native)).toThrow('conflicts with');
  });

  it('rejects an authored name that shadows another binding', () => {
    expect(() =>
      readVersionMetadataBinding({
        version_metadata: { binding: 'VERSION' },
        ai: { binding: 'VERSION' },
      }),
    ).toThrow('conflicts with AI');
  });

  it.each([{}, { binding: '' }, 'VERSION', [{ binding: 'VERSION' }]])(
    'fails closed on malformed authored metadata: %j',
    (value) => {
      expect(() => readVersionMetadataBinding({ version_metadata: value })).toThrow();
    },
  );
});
