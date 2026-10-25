// The HTKK XML of form 01/GTGT for a period's VAT working (issue #332, GET /api/export/vat-01gtgt.xml). The layout,
// the values and their sources are in domain/vat-01gtgt-xml.ts and docs/integrations/htkk-01gtgt-xml.md.
import { vietnamToday } from '@crove/kernel-contract';
import { DomainError } from '@crove/kernel-runtime';
import { HtkkAmountError, buildForm01Xml, type Vat01Values } from './domain/vat-01gtgt-xml.ts';
import type { VatDeclaration, VatReport } from './vat.ts';

// Where [22] of the file comes from (#1400), for the export's audit row: the previous filed return's [43], an amount
// the accountant typed on the VAT screen, or 0 for want of a previous return.
export type XmlCarryForwardSource = 'previous' | 'edited' | 'none';

/**
 * [22] of the HTKK file: `typed` (the ?carried= of the route, a whole number of dong the accountant may have edited on
 * the VAT screen) when given, else the [43] of the return filed for the period before (report.carryForward), else 0.
 * Refuses anything but a whole, non-negative number of at most 14 digits.
 */
export function xmlCarryForward(report: Pick<VatReport, 'carryForward'>, typed: string | undefined): { amount: string; source: XmlCarryForwardSource } {
  const previous = report.carryForward;
  const fallback: XmlCarryForwardSource = previous.previous ? 'previous' : 'none';
  if (typed === undefined) return { amount: previous.amount, source: fallback };
  if (!/^\d{1,14}$/.test(typed)) {
    throw new DomainError('INVALID', 422, 'Chỉ tiêu [22] phải là số tiền nguyên, không âm, tối đa 14 chữ số');
  }
  const amount = BigInt(typed).toString();
  return { amount, source: amount === previous.amount ? fallback : 'edited' };
}

export function buildVat01Xml(declaration: VatDeclaration, today: string = vietnamToday(), values: Vat01Values = {}): string {
  // A return names the taxpayer; a blank name would write an empty <tenNNT/> that GDT may refuse, so refuse it here.
  if (declaration.taxpayer.name.replace(/\s+/g, ' ').trim() === '') {
    throw new DomainError('TAXPAYER_NAME_REQUIRED', 422, 'Tổ chức chưa có tên. Nhập tên tổ chức trong Cài đặt rồi xuất lại.');
  }
  try {
    return buildForm01Xml({ period: declaration.report.period, indicators: declaration.report.indicators }, declaration.taxpayer, { ...values, today });
  } catch (error) {
    if (error instanceof HtkkAmountError) {
      throw new DomainError('INVALID', 422, `Chỉ tiêu [${error.code}] vượt quá 14 chữ số, mức HTKK nhận được; hãy kiểm tra lại các hóa đơn của kỳ này`);
    }
    throw error;
  }
}
