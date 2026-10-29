// The org's own tax code (MST, issue #313). Finance compares it with the seller of an e-invoice to tell a sale (the org
// issued the invoice) from a purchase. Optional: an org without one records every invoice as a purchase, as before.
// Stored normalized (normalizeTaxCode; the column's CHECK constraint holds the same shape). Owners and admins set or
// clear it; the runtime audits every change. The detail says whether it changed and keeps a marker naming the class in
// place of the old and the new value: a household business's tax code is its owner's national id (auditValue, #1626),
// and tenant_tax_code_requires_audit accepts that marker for a code that is set (20261103070000). The org's default
// legal entity (#1278) keeps the same tax code: the database writes it with the tenant row
// (tenant_default_entity_tax_code, #1316), and a code another legal entity of the org holds is refused. A 12-digit code
// makes the default entity a household business unless an owner or an admin chose its kind (#1317).
import { z } from 'zod';
import { VAT_FILING_PERIODS, auditValue, normalizeTaxCode } from '@crove/kernel-contract';
import { DomainError, defineCommand } from '@crove/kernel-runtime';
import { assertOrgTaxCodeFree, defaultKindForTaxCode, onWrite, setDefaultEntityTaxCode } from './legal-entities.ts';
import { kernelManifest } from './manifest.ts';

const TENANT = kernelManifest.tables.crove_kernel.tenant;

export const setTaxCode = defineCommand({
  name: 'kernel.org.set_tax_code',
  input: z.object({ taxCode: z.string().trim().max(20).nullable() }),
  risk: 'R1',
  sideEffect: 'internal',
  access: ['owner', 'admin'],
  handler: async (ctx, input) => {
    const taxCode = input.taxCode ? normalizeTaxCode(input.taxCode) : null;
    if (input.taxCode && !taxCode) {
      throw new DomainError('INVALID_TAX_CODE', 422, 'Mã số thuế không hợp lệ: 10 chữ số, 10 chữ số kèm 3 chữ số đơn vị phụ thuộc, hoặc 12 chữ số');
    }
    const before = await ctx.trx.selectFrom('crove_kernel.tenant').select('tax_code').where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    await assertOrgTaxCodeFree(ctx, taxCode);
    if (before.tax_code !== taxCode) {
      // The database writes the new code to the default entity too (tenant_default_entity_tax_code); its unique index
      // refuses a code another entity took after the check above.
      await ctx.trx.updateTable('crove_kernel.tenant').set({ tax_code: taxCode }).where('org_id', '=', ctx.orgId).execute().catch(onWrite(taxCode));
      // Members see the change in the activity feed: it decides which invoices are read as sales from now on.
      await ctx.activity('kernel.tenant', ctx.orgId, 'org.tax_code_changed', taxCode ? 'Đặt mã số thuế của tổ chức' : 'Xóa mã số thuế của tổ chức');
    }
    // After the tenant row, as kernel.legal_entity.update takes them. A no-op unless the default entity was left on an
    // old code before #1316.
    const writer = { trx: ctx.trx, orgId: ctx.orgId, now: ctx.now, userId: ctx.actor.type === 'user' ? ctx.actor.userId : null };
    await setDefaultEntityTaxCode(writer, taxCode);
    // A 12-digit code makes the default entity a household business, unless someone chose its kind (#1317).
    const defaultKind = await defaultKindForTaxCode(writer, taxCode);
    const changed = before.tax_code !== taxCode;
    ctx.audit({
      previous: auditValue(TENANT, 'tax_code', before.tax_code),
      taxCode: auditValue(TENANT, 'tax_code', taxCode),
      changed,
      ...(defaultKind ? { defaultEntityKind: defaultKind } : {}),
    });
    return { taxCode };
  },
});

// How often the org files its VAT return (issue #318), for the next deadline on the multi-client home screen. Owners and
// admins choose it, or clear the choice (null). Audited with the old and the new value, and shown in the activity feed
// like the tax code.
export const setVatFilingPeriod = defineCommand({
  name: 'kernel.org.set_vat_filing_period',
  input: z.object({ vatFilingPeriod: z.enum(VAT_FILING_PERIODS).nullable() }),
  risk: 'R1',
  sideEffect: 'internal',
  access: ['owner', 'admin'],
  handler: async (ctx, input) => {
    const before = await ctx.trx.selectFrom('crove_kernel.tenant').select('vat_filing_period').where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    const next = input.vatFilingPeriod;
    if (before.vat_filing_period !== next) {
      await ctx.trx.updateTable('crove_kernel.tenant').set({ vat_filing_period: next }).where('org_id', '=', ctx.orgId).execute();
      const summary =
        next === 'month' ? 'Chọn kỳ khai thuế GTGT theo tháng' : next === 'quarter' ? 'Chọn kỳ khai thuế GTGT theo quý' : 'Bỏ chọn kỳ khai thuế GTGT';
      await ctx.activity('kernel.tenant', ctx.orgId, 'org.vat_filing_period_changed', summary);
    }
    ctx.audit({ previous: before.vat_filing_period, vatFilingPeriod: next });
    return { vatFilingPeriod: next };
  },
});
