// The org's own tax code (MST, issue #313). Finance compares it with the seller of an e-invoice to tell a sale (the org
// issued the invoice) from a purchase. Optional: an org without one records every invoice as a purchase, as before.
// Stored normalized (normalizeTaxCode; the column's CHECK constraint holds the same shape). Owners and admins set or
// clear it; the runtime audits every change, and the detail keeps the old and the new value (a tax code is public
// business data, not a secret).
import { z } from 'zod';
import { normalizeTaxCode } from '@crove/kernel-contract';
import { DomainError, defineCommand } from '@crove/kernel-runtime';

export const setTaxCode = defineCommand({
  name: 'kernel.org.set_tax_code',
  input: z.object({ taxCode: z.string().trim().max(20).nullable() }),
  risk: 'R1',
  access: ['owner', 'admin'],
  handler: async (ctx, input) => {
    const taxCode = input.taxCode ? normalizeTaxCode(input.taxCode) : null;
    if (input.taxCode && !taxCode) {
      throw new DomainError('INVALID_TAX_CODE', 422, 'Mã số thuế không hợp lệ: 10 chữ số, 10 chữ số kèm 3 chữ số đơn vị phụ thuộc, hoặc 12 chữ số');
    }
    const before = await ctx.trx.selectFrom('crove_kernel.tenant').select('tax_code').where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    if (before.tax_code !== taxCode) {
      await ctx.trx.updateTable('crove_kernel.tenant').set({ tax_code: taxCode }).where('org_id', '=', ctx.orgId).execute();
    }
    ctx.audit({ previous: before.tax_code, taxCode });
    return { taxCode };
  },
});
