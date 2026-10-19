import { createAccount, setVendorDefaultAccount, updateAccount } from './accounts.ts';
import { recordPurchase, revisePurchase } from './record.ts';
import { prepareVoucher, recordVoucher, vouchersList } from './cash-voucher.ts';
import { prepareReversal, reverseEntry } from './reversal.ts';
import { openingBalancePost, openingBalancePreview } from './opening-balance.ts';
import { fileForExtraction, purchaseLookup } from './extract.ts';
import { accountsList, documentsList, journalExport, journalGet, journalList, purchaseVouchers, salesVouchers, vendorsList, voidedProposals } from './queries.ts';
import { vatExport, vatPeriodQuery } from './vat.ts';
import { ledgerAccountQuery, ledgerBookQuery, ledgerExport, ledgerPeriodQuery } from './ledger-reports.ts';

export { extractAndPropose, recordExtractionFailure, type ExtractDeps } from './extract.ts';
export { buildJournalWorkbook } from './export.ts';
export { buildVatWorkbook, VAT_RATE_LABELS, VAT_WARNING_LABELS } from './vat-export.ts';
export { buildLedgerWorkbook } from './ledger-export.ts';
export {
  MISA_SME_PURCHASE_SERVICE,
  MISA_SME_SALES,
  buildMisaWorkbook,
  purchaseRows,
  salesRows,
  type PurchaseVoucher,
  type SalesVoucher,
} from './misa.ts';
export { CHIEF_ACCOUNTANT_TEMPLATE, chiefAccountantReview, financeAgentPrograms, reviewText } from './agent.ts';
export * from './domain/money.ts';
export * from './domain/ledger.ts';
export * from './domain/tt133-reports.ts';
export * from './domain/vat-return.ts';
export * from './domain/ledger-reports.ts';
export * from './domain/opening-balance.ts';
export * from './domain/cash-voucher.ts';
export { type OrgChartAccount } from './accounts.ts';
export { VOUCHER_LIST_LIMIT } from './cash-voucher.ts';
export { REVERSAL_COMMAND, REVERSAL_KIND, zJournalReversal, type JournalReversal } from './reversal.ts';
export { JOURNAL_EXPORT_LIMIT, VOIDED_PROPOSALS_QUERY, type JournalEntryView } from './queries.ts';
export { VAT_PERIOD_LIMIT, VAT_WARNINGS, type VatInvoiceView, type VatReport, type VatSide, type VatWarning } from './vat.ts';
export { LEDGER_LINE_LIMIT, type AccountLedgerView, type LedgerBook, type LedgerReport } from './ledger-reports.ts';

export const financeCommands = [recordPurchase, revisePurchase, prepareReversal, reverseEntry, journalExport, vatExport, ledgerExport, openingBalancePost, createAccount, updateAccount, setVendorDefaultAccount, prepareVoucher, recordVoucher];
export const financeQueries = [
  fileForExtraction,
  purchaseLookup,
  vendorsList,
  documentsList,
  journalList,
  journalGet,
  accountsList,
  voidedProposals,
  purchaseVouchers,
  salesVouchers,
  vatPeriodQuery,
  ledgerPeriodQuery,
  ledgerAccountQuery,
  ledgerBookQuery,
  openingBalancePreview,
  vouchersList,
];
