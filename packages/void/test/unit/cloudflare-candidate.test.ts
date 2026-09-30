import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  assertCloudflareCandidateUnchanged,
  clearCloudflareCandidate,
  readCloudflareCandidate,
  recordCloudflareCandidateUpload,
} from '../../src/cli/cloudflare-candidate.ts';

describe('ordinary Cloudflare candidate receipt', () => {
  it('records a candidate for one live Worker and rejects changed local state', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-candidate-'));
    try {
      recordCloudflareCandidateUpload(root, null, 'account', 'worker', 'live', 'draft');
      const receipt = readCloudflareCandidate(root);
      expect(receipt).toEqual({
        accountId: 'account',
        workerName: 'worker',
        parentVersionId: 'live',
        versionIds: ['draft'],
      });
      recordCloudflareCandidateUpload(root, receipt, 'account', 'worker', 'live', 'draft-2');
      expect(readCloudflareCandidate(root)?.versionIds).toEqual(['draft', 'draft-2']);
      expect(() => assertCloudflareCandidateUnchanged(root, receipt)).toThrow('changed');
      expect(() =>
        recordCloudflareCandidateUpload(
          root,
          readCloudflareCandidate(root),
          'other',
          'worker',
          'live',
          'draft-3',
        ),
      ).toThrow('different Worker');
      clearCloudflareCandidate(root);
      expect(readCloudflareCandidate(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed on malformed receipt', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-candidate-'));
    try {
      recordCloudflareCandidateUpload(root, null, 'account', 'worker', 'live', 'draft');
      const path = join(root, '.void', 'cloudflare-candidate.json');
      writeFileSync(path, readFileSync(path, 'utf8').replace('"draft"', '""'));
      expect(() => readCloudflareCandidate(root)).toThrow('invalid');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('starts a new chain only when the verified parent is the last saved candidate', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-candidate-activated-'));
    try {
      recordCloudflareCandidateUpload(root, null, 'account', 'worker', 'live', 'draft');
      recordCloudflareCandidateUpload(
        root,
        readCloudflareCandidate(root),
        'account',
        'worker',
        'live',
        'draft-2',
      );
      const receipt = readCloudflareCandidate(root);
      expect(() =>
        recordCloudflareCandidateUpload(root, receipt, 'account', 'worker', 'draft', 'next'),
      ).toThrow('different Worker');
      expect(() =>
        recordCloudflareCandidateUpload(root, receipt, 'other', 'worker', 'draft-2', 'next'),
      ).toThrow('different Worker');
      expect(() =>
        recordCloudflareCandidateUpload(root, receipt, 'account', 'other', 'draft-2', 'next'),
      ).toThrow('different Worker');
      expect(readCloudflareCandidate(root)).toEqual(receipt);
      recordCloudflareCandidateUpload(root, receipt, 'account', 'worker', 'draft-2', 'next');
      expect(readCloudflareCandidate(root)).toEqual({
        accountId: 'account',
        workerName: 'worker',
        parentVersionId: 'draft-2',
        versionIds: ['next'],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
