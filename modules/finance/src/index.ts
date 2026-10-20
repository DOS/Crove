import { createAccount, setVendorDefaultAccount, updateAccount } from './accounts.ts';
import { recordPurchase, revisePurchase } from './record.ts';
import { prepareVoucher, recordVoucher, vouchersList } from './cash-voucher.ts';
import { prepareReversal, reverseEntry } from './reversal.ts';
import { openingBalancePost, openingBalancePreview } from './opening-balance.ts';
import { fileForExtraction, purchaseLookup } from './extract.ts';
import { accountsList, documentsList, journalExport, journalGet, journalList, purchaseVouchers, salesVouchers, vendorsList, voidedProposals } from './queries.ts';
import { vatDeclarationQuery, vatExport, vatPeriodQuery } from './vat.ts';
import { ledgerAccountQuery, ledgerBookQuery, ledgerExport, ledgerPeriodQuery } from './ledger-reports.ts';
import { portalListImport, portalListReconcile, portalListRecord, portalListRemove, portalListSource } from './portal-list.ts';
import { bankImport, bankLines, bankPreview } from './bank.ts';
import { bankLineVoucher } from './bank-match.ts';
import { periodLock, periodLockStateQuery, periodUnlock } from './period-lock.ts';
import { statementsExport, statementsPeriodQuery } from './statements.ts';

export { extractAndPropose, recordExtractionFailure, type ExtractDeps } from './extract.ts';
export {
  checkPortalList,
  firstPerOutcome,
  importPortalList,
  recordPortalListFailure,
  PORTAL_PERIOD_ROW_LIMIT,
  PORTAL_RECONCILE_ITEMS_PER_OUTCOME,
  PORTAL_RECONCILE_LIMIT,
  type PortalListDeps,
} from './portal-list.ts';
export * from './domain/portal-reconcile.ts';
export { foldVietnamese, portalStatus } from './domain/portal-status.ts';
export { buildJournalWorkbook } from './export.ts';
export { buildVatWorkbook, VAT_RATE_LABELS, VAT_WARNING_LABELS } from './vat-export.ts';
export { buildVat01Xml } from './vat-xml.ts';
export { buildLedgerWorkbook } from './ledger-export.ts';
export { buildStatementsWorkbook } from './statements-export.ts';
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
export * from './domain/vat-01gtgt-xml.ts';
export * from './domain/ledger-reports.ts';
export * from './domain/opening-balance.ts';
export * from './domain/cash-voucher.ts';
export * from './domain/bank-statement.ts';
export * from './domain/bank-match.ts';
export { type OrgChartAccount } from './accounts.ts';
export { REVERSAL_COMMAND, REVERSAL_KIND, zJournalReversal, type JournalReversal } from './reversal.ts';
export { JOURNAL_EXPORT_LIMIT, VOIDED_PROPOSALS_QUERY, type JournalEntryView } from './queries.ts';
export {
  VAT_EXPORT_FORMATS,
  VAT_PERIOD_LIMIT,
  VAT_WARNINGS,
  type VatDeclaration,
  type VatInvoiceView,
  type VatReport,
  type VatSide,
  type VatTaxpayer,
  type VatWarning,
} from './vat.ts';
export { LEDGER_LINE_LIMIT, type AccountLedgerView, type LedgerBook, type LedgerReport } from './ledger-reports.ts';
export { type FinancialStatements, type StatementLine, type UnmappedRow } from './statements.ts';

export const financeCommands = [recordPurchase, revisePurchase, prepareReversal, reverseEntry, journalExport, vatExport, ledgerExport, statementsExport, openingBalancePost, periodLock, periodUnlock, bankImport, createAccount, updateAccount, setVendorDefaultAccount, prepareVoucher, recordVoucher, portalListImport, portalListRemove, portalListRecord];
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
  vatDeclarationQuery,
  ledgerPeriodQuery,
  ledgerAccountQuery,
  ledgerBookQuery,
  statementsPeriodQuery,
  openingBalancePreview,
  vouchersList,
  portalListSource,
  portalListReconcile,
  periodLockStateQuery,
  bankPreview,
  bankLines,
  bankLineVoucher,
];
