// SPDX-License-Identifier: AGPL-3.0-only
// How many extract jobs the worker starts workers for (#2119): the extract client's slots, 1 when it names none.
import { describe, expect, it } from 'vitest';
import { createExtractClient, type ExtractClient } from '@crove/extract-contract';
import { extractWorkers } from '../src/worker.ts';

describe('extractWorkers', () => {
  it('takes the extract client slots', () => {
    for (const slots of [1, 2, 4, 8]) expect(extractWorkers(createExtractClient({ url: 'http://crove-extract:8090', concurrency: slots }))).toBe(slots);
  });

  it('is 1 for a client that names no slots, and never below 1 or fractional', () => {
    const bare = { extract: async () => ({ ok: false, code: 'invalid', message: 'x' }) } as unknown as ExtractClient;
    expect(extractWorkers(bare)).toBe(1);
    expect(extractWorkers({ ...bare, concurrency: 0 })).toBe(1);
    expect(extractWorkers({ ...bare, concurrency: 2.9 })).toBe(2);
    expect(extractWorkers(createExtractClient({ url: 'http://crove-extract:8090' }))).toBe(1);
  });
});
