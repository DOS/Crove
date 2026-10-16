// The staging sweep of the daily retention job (issue #223): an hour's cutoff, calls until nothing is left within a
// budget, an ALERT when objects remain, and a failure that never stops the rest of the job.
import { describe, expect, it } from 'vitest';
import type { BlobStore, StagingSweep } from '@crove/kernel-runtime';
import { STAGING_MAX_AGE_MS, STAGING_SWEEP_LIMIT, sweepStaging } from '../src/retention.ts';

const base: BlobStore = {
  put: async () => 'content:x',
  get: async () => new Uint8Array(),
  delete: async () => undefined,
};

function recorder() {
  const logs: string[] = [];
  const errors: string[] = [];
  return { logs, errors, log: { log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) } };
}

function scripted(answers: StagingSweep[]) {
  const calls: Array<[Date, number]> = [];
  const store: BlobStore = {
    ...base,
    sweepStaging: async (before, limit) => {
      calls.push([before, limit]);
      const next = answers.shift();
      if (!next) throw new Error('called once too often');
      return next;
    },
  };
  return { store, calls };
}

describe('sweepStaging', () => {
  it('asks for staging objects older than an hour and calls again while more remain', async () => {
    const { store, calls } = scripted([
      { deleted: 10, more: true },
      { deleted: 3, more: false },
    ]);
    const r = recorder();
    const now = new Date('2026-10-17T02:30:00Z');
    await expect(sweepStaging(store, now, undefined, r.log)).resolves.toEqual({ deleted: 13, more: false });
    const before = new Date(now.getTime() - STAGING_MAX_AGE_MS);
    expect(calls).toEqual([
      [before, STAGING_SWEEP_LIMIT],
      [before, STAGING_SWEEP_LIMIT],
    ]);
    expect(STAGING_MAX_AGE_MS).toBe(60 * 60 * 1000);
    expect(r.logs).toEqual(['[retention] staging objects deleted=13']);
    expect(r.errors).toEqual([]);
  });

  it('stops at the call budget, or when a call deletes nothing, and raises an ALERT for what remains', async () => {
    const capped = scripted([
      { deleted: 5, more: true },
      { deleted: 5, more: true },
    ]);
    const r = recorder();
    await expect(sweepStaging(capped.store, new Date(), 5, r.log, 2)).resolves.toEqual({ deleted: 10, more: true });
    expect(capped.calls).toHaveLength(2);
    expect(r.errors).toEqual(['[retention] ALERT staging objects remain after deleting 10; set a lifecycle rule on staging/ (ADR-0013)']);

    // Only young objects in the window: another call would list the same keys.
    const young = scripted([{ deleted: 0, more: true }]);
    await expect(sweepStaging(young.store, new Date(), 5, recorder().log)).resolves.toEqual({ deleted: 0, more: true });
    expect(young.calls).toHaveLength(1);
  });

  it('does nothing for a store without staging objects (local disk)', async () => {
    await expect(sweepStaging(base)).resolves.toBeNull();
  });

  it('logs a failure as an ALERT and returns null instead of throwing', async () => {
    const store: BlobStore = {
      ...base,
      sweepStaging: async () => {
        throw new Error('AccessDenied');
      },
    };
    const r = recorder();
    await expect(sweepStaging(store, new Date(), 10, r.log)).resolves.toBeNull();
    expect(r.errors).toEqual(['[retention] ALERT staging sweep failed after deleting 0']);
  });
});
