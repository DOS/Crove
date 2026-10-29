// The legal entity the Inbox shows for a proposal (#1625): kernel.inbox.list and kernel.inbox.get read the revision's
// entity through one helper, from the same kinds only (an invoice, a cash voucher, a general journal voucher), and fall
// back to the proposal's own entity.
import { describe, expect, it } from 'vitest';
import { JOURNAL_VOUCHER_KIND, VOUCHER_KIND } from '@crove/kernel-contract';
import { revisionLegalEntity } from '@crove/kernel';

const OWN = '11111111-1111-4111-8111-111111111111';
const NAMED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('the legal entity a proposal shows (#1625)', () => {
  it('reads the revision’s entity from an invoice, a cash voucher and a general journal voucher', () => {
    for (const kind of ['finance.purchase', VOUCHER_KIND, JOURNAL_VOUCHER_KIND]) {
      expect(revisionLegalEntity(kind, NAMED, OWN), kind).toBe(NAMED);
      expect(revisionLegalEntity(kind, NAMED.toUpperCase(), OWN), kind).toBe(NAMED);
    }
  });

  it('never reads another kind’s payload, and falls back to the proposal’s own entity', () => {
    for (const kind of ['finance.journal_reversal', 'finance.bank_statement', 'kernel.anything']) {
      expect(revisionLegalEntity(kind, NAMED, OWN), kind).toBe(OWN);
    }
    for (const named of [undefined, null, '', 'not an id', 42, { id: NAMED }, `${NAMED} `]) {
      expect(revisionLegalEntity('finance.purchase', named, OWN), String(named)).toBe(OWN);
    }
  });
});
