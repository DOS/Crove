// SPDX-License-Identifier: AGPL-3.0-only
// The kernel asks the finance lookup again when it records a proposal (#2137). It names the query by string, as it does
// for the voided proposals, so a rename here would silently turn the guard into a no-op: pinned by this test.
import { describe, expect, it } from 'vitest';
import { DUPLICATE_LOOKUP_QUERY } from '@crove/kernel';
import { purchaseLookup } from '../src/extract.ts';

describe('duplicate guard', () => {
  it('names the lookup query finance registers', () => {
    expect(DUPLICATE_LOOKUP_QUERY).toBe(purchaseLookup.name);
  });
});
