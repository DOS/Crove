// The year-end financial statements as HTKK XML (issue #920): B01a-DNN, B02-DNN and F01-DNN of a calendar year from
// the ledger, in the layout of domain/statements-htkk-xml.ts. GET /api/export/statements-htkk.xml?year= reads
// finance.statements.htkk and records its download with finance.statements.export (format htkk_bctc_xml), like the
// 01/GTGT export. finance.statements.htkk_check says, before the download, what the file would get wrong or leave out:
// the year's closing entries (#889) not posted, B01 not balancing, balances no line reads, accounts outside HTKK's
// trial balance list. They are warnings: the accountant decides, the file is still written.
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { vietnamToday, zId, zStatementsHtkkYear, type StatementsHtkkCheck, type StatementsHtkkWarning } from '@crove/kernel-contract';
import { DomainError, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { buildStatementsXml, f01Values, type BctcInput, type BctcTaxpayer } from './domain/statements-htkk-xml.ts';
import { HtkkAmountError } from './domain/vat-01gtgt-xml.ts';
import { yearTrialBalance } from './ledger-reports.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import { financialStatements } from './statements.ts';
import { isClosed } from './year-closing.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

// The statements of one legal entity (#1280): legalEntityId as in zLegalEntityChoice. The taxpayer block is still the
// org's (its tax code, name and address).
export const zStatementsYearInput = z.object({ year: zStatementsHtkkYear, legalEntityId: zId.optional() });
export type { StatementsHtkkWarning };

export interface StatementsFiling {
  input: BctcInput;
  taxpayer: BctcTaxpayer;
  warnings: StatementsHtkkWarning[];
  // The accounts F01 leaves out (F01_UNCOVERED).
  uncovered: string[];
}

async function loadFiling(ctx: QueryContext, year: number, legalEntityId: string): Promise<Omit<StatementsFiling, 'taxpayer'>> {
  const current = await financialStatements(ctx, String(year), legalEntityId);
  const previous = await financialStatements(ctx, String(year - 1), legalEntityId);
  const tb = await yearTrialBalance(ctx, year, legalEntityId);
  const { uncovered } = f01Values(tb);
  const warnings: StatementsHtkkWarning[] = [];
  if (!(await isClosed(ctx, year, legalEntityId))) warnings.push('YEAR_NOT_CLOSED');
  if (!current.b01.balanced || !previous.b01.balanced) warnings.push('B01_UNBALANCED');
  if ([current, previous].some((s) => s.b01.unmapped.length > 0 || s.b02.unmapped.length > 0)) warnings.push('UNMAPPED_BALANCES');
  if (uncovered.length > 0) warnings.push('F01_UNCOVERED');
  return {
    input: { year, current: { b01: current.b01.lines, b02: current.b02.lines }, previous: { b01: previous.b01.lines, b02: previous.b02.lines }, trialBalance: tb },
    warnings,
    uncovered,
  };
}

// What the file of the year would get wrong or leave out. Needs no tax code, so the screen can say it first.
export const statementsHtkkCheckQuery = defineQuery({
  name: 'finance.statements.htkk_check',
  input: zStatementsYearInput,
  access: ALL,
  handler: async (ctx, { year, legalEntityId }): Promise<StatementsHtkkCheck> => {
    const { warnings, uncovered } = await loadFiling(ctx, year, await resolveLegalEntity(ctx, legalEntityId));
    return { year, warnings, uncovered };
  },
});

// Everything the XML of the year is made from, with the taxpayer. Refuses an org without a tax code.
export const statementsHtkkQuery = defineQuery({
  name: 'finance.statements.htkk',
  input: zStatementsYearInput,
  access: ALL,
  handler: async (ctx, { year, legalEntityId }): Promise<StatementsFiling> => {
    const entity = await resolveLegalEntity(ctx, legalEntityId);
    const org = await ctx.trx.selectFrom('crove_kernel.tenant').select(['tax_code', 'name', 'address']).where('org_id', '=', ctx.orgId).executeTakeFirst();
    if (!org?.tax_code) throw new DomainError('TAX_CODE_REQUIRED', 422, 'Tổ chức chưa có mã số thuế. Nhập mã số thuế trong Cài đặt rồi xuất lại.');
    return { ...(await loadFiling(ctx, year, entity)), taxpayer: { taxCode: org.tax_code, name: org.name, address: org.address } };
  },
});

/** The XML of a filing, with the refusals the user can read: a blank org name, an amount HTKK cannot hold. */
export function buildStatementsHtkkXml(filing: StatementsFiling, today: string = vietnamToday()): string {
  if (filing.taxpayer.name.replace(/\s+/g, ' ').trim() === '') {
    throw new DomainError('TAXPAYER_NAME_REQUIRED', 422, 'Tổ chức chưa có tên. Nhập tên tổ chức trong Cài đặt rồi xuất lại.');
  }
  try {
    return buildStatementsXml(filing.input, filing.taxpayer, { today });
  } catch (error) {
    if (error instanceof HtkkAmountError) {
      throw new DomainError('INVALID', 422, `Chỉ tiêu ${error.code} vượt quá 14 chữ số, mức HTKK nhận được; hãy kiểm tra lại sổ của năm này`);
    }
    throw error;
  }
}

export const statementsHtkkQueries = [statementsHtkkCheckQuery, statementsHtkkQuery];
