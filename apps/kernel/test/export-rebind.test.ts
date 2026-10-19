// Export rebind after a restore (issue #351), unit part: the org ids it accepts. The database part, re-recording an
// export with the restored object versions, is in offboarding.db.test.ts.
import { describe, expect, it } from 'vitest';
import type { BlobStore, Runtime } from '@crove/kernel-runtime';
import { rebindExports } from '../src/export-rebind.ts';

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
