// Export rebind after a restore (issue #351), unit part: which read errors mean a stale record, and the org ids it
// accepts. The database part, re-recording an
// export with the restored object versions, is in offboarding.db.test.ts.
import { describe, expect, it } from 'vitest';
import { BlobStoreAccessError, sha256Hex, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import { rebindExport, rebindExports } from '../src/export-rebind.ts';

function fakeRuntime() {
  const orgIds: string[] = [];
  const runtime = {
    query: async (_name: string, _input: unknown, opts: { orgId: string }) => {
      orgIds.push(opts.orgId);
      return null;
    },
    execute: async () => {
      throw new Error('nothing to record');
    },
  } as unknown as Pick<Runtime, 'query' | 'execute'>;
  return { runtime, orgIds };
}

const store = {} as BlobStore;

describe('exports-rebind on a store from another provider', () => {
  const bytes = new TextEncoder().encode('sealed export part');
  const sha = sha256Hex(bytes);
  const orgId = '01a1557f-55d2-75de-a3cb-d7350a65a5b4';
  const key = `export/${orgId}/${sha}`;
  const record = { format: 'crove.org-export.v2', manifestKey: key, manifestSha256: sha, manifestGeneration: 's3:aws-version', fileCount: 0, encryption: 'none', expiresAt: '2099-01-01T00:00:00.000Z', parts: [] };

  function setup(readError: Error) {
    const recorded: unknown[] = [];
    const runtime = {
      query: async () => record,
      execute: async (_name: string, input: unknown) => {
        recorded.push(input);
        return { ok: true };
      },
    } as unknown as Pick<Runtime, 'query' | 'execute'>;
    const store = {
      get: async (_key: string, generation?: string | null) => {
        if (generation) throw readError;
        return bytes;
      },
      put: async () => 's3:minio-version',
      delete: async () => {},
    } as unknown as BlobStore;
    return { runtime, store, recorded };
  }

  it('treats a version id the store cannot parse (400 InvalidArgument) as stale and re-records', async () => {
    const { runtime, store, recorded } = setup(Object.assign(new Error('Invalid version id specified'), { name: 'InvalidArgument' }));
    expect(await rebindExport({ runtime, store }, orgId)).toBe('rebound');
    expect(recorded).toEqual([{ ...record, manifestGeneration: 's3:minio-version', rebind: true }]);
  });

  it('never papers over an access refusal: the org is reported and the others go on', async () => {
    const { runtime, store, recorded } = setup(new BlobStoreAccessError('crove-files', key, new Error('403')));
    const lines: string[] = [];
    expect(await rebindExports({ runtime, store, log: (l) => lines.push(l) }, [orgId])).toBe(1);
    expect(recorded).toEqual([]);
    expect(lines[0]).toMatch(/FAILED, the owner must ask for a new export/);
  });
});

describe('exports-rebind org ids', () => {
  it('accepts an org id in any case and uses it in lower case, as storage keys and PostgreSQL do', async () => {
    const { runtime, orgIds } = fakeRuntime();
    const lines: string[] = [];
    const upper = '01A1557F-55D2-75DE-A3CB-D7350A65A5B4';
    expect(await rebindExports({ runtime, store, log: (l) => lines.push(l) }, [upper])).toBe(0);
    expect(orgIds).toEqual([upper.toLowerCase()]);
    expect(lines).toEqual([`[exports-rebind] org ${upper.toLowerCase()}: no live export`]);
  });

  it('refuses what is not an org id and goes on with the others', async () => {
    const { runtime, orgIds } = fakeRuntime();
    const lines: string[] = [];
    const ok = '01a1557f-55d2-75de-a3cb-d7350a65a5b4';
    expect(await rebindExports({ runtime, store, log: (l) => lines.push(l) }, ["x'; DROP TABLE t; --", ok])).toBe(1);
    expect(orgIds).toEqual([ok]);
    expect(lines[0]).toBe("[exports-rebind] x'; DROP TABLE t; --: not an org id");
  });
});
