// The finance module's manifest (plan §5.2, #1588): the tables it owns. A migration that adds or drops a table of these
// schemas changes this list in the same PR; apps/kernel/test/manifest.db.test.ts checks it against the catalog.
import { defineModule } from '@crove/kernel-contract';

export const financeManifest = defineModule({
  id: 'finance',
  tables: {
    crove_finance: [
      'account',
      'bank_line',
      'cash_voucher',
      'categorization_rule',
      'chart',
      'chart_account',
      'depreciation_line',
      'fixed_asset',
      'input_vat_check',
      'journal_entry',
      'journal_line',
      'journal_voucher',
      'legal_entity_books',
      'misa_goods_code',
      'org_account',
      'period_balance_delta',
      'period_lock',
      'portal_invoice_list',
      'portal_invoice_row',
      'purchase_document',
      'purchase_document_void',
      'purchase_line',
      'purchase_tax_rate',
      'vat_return_filed',
      'vendor_account_rule',
    ],
  },
});
