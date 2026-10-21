// The year-end financial statements as HTKK XML (#920): the year asked for and what the file would get wrong or leave
// out, shared with the SPA. The finance module decides each warning (modules/finance/src/statements-htkk.ts).
import { z } from 'zod';

// A calendar year whose previous year is a ledger period too (2000 to 2099).
export const zStatementsHtkkYear = z.number().int().min(2001).max(2099);

// YEAR_NOT_CLOSED: the year's closing entries (#889) are not posted, so B01 shows the result outside 4212.
// B01_UNBALANCED: B01 of the year or of the previous year does not balance. UNMAPPED_BALANCES: balances no line of
// B01 or B02 reads. F01_UNCOVERED: accounts outside HTKK's trial balance list, left out of F01.
export const STATEMENTS_HTKK_WARNINGS = ['YEAR_NOT_CLOSED', 'B01_UNBALANCED', 'UNMAPPED_BALANCES', 'F01_UNCOVERED'] as const;
export type StatementsHtkkWarning = (typeof STATEMENTS_HTKK_WARNINGS)[number];

export const zStatementsHtkkCheck = z.object({
  year: zStatementsHtkkYear,
  warnings: z.array(z.enum(STATEMENTS_HTKK_WARNINGS)),
  // The accounts F01 leaves out.
  uncovered: z.array(z.string()),
});
export type StatementsHtkkCheck = z.infer<typeof zStatementsHtkkCheck>;
