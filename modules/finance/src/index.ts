import { recordPurchase } from './record.ts';
import { fileForExtraction, purchaseLookup } from './extract.ts';
import { accountsList, documentsList, journalList, vendorsList } from './queries.ts';

export { extractAndPropose, type ExtractDeps } from './extract.ts';
export { buildJournalWorkbook } from './export.ts';
export type { JournalEntryView } from './queries.ts';

export const financeCommands = [recordPurchase];
export const financeQueries = [fileForExtraction, purchaseLookup, vendorsList, documentsList, journalList, accountsList];
