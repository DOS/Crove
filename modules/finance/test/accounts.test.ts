// Which database refusals mean "this sub-account is inactive" (issue #368): only the vendor default check's own
// message, not every 23503, so a foreign key failure is not reported as an inactive account.
import { describe, expect, it } from 'vitest';
import { isInactiveDefaultRefusal } from '../src/accounts.ts';

describe('isInactiveDefaultRefusal', () => {
  it('matches the check on a vendor default only', () => {
    expect(isInactiveDefaultRefusal({ code: '23503', message: 'sub-account 6422.MKT is inactive and cannot be a vendor default' })).toBe(true);
    expect(
      isInactiveDefaultRefusal({
        code: '23503',
        message: 'insert or update on table "vendor_account_rule" violates foreign key constraint "vendor_account_rule_org_id_party_id_fkey"',
      }),
    ).toBe(false);
    expect(isInactiveDefaultRefusal({ code: '23505', message: 'sub-account 6422.MKT is inactive and cannot be a vendor default' })).toBe(false);
    expect(isInactiveDefaultRefusal(new Error('boom'))).toBe(false);
    expect(isInactiveDefaultRefusal(null)).toBe(false);
  });
});
