// The HTKK XML of form 01/GTGT for a period's VAT working (issue #332, GET /api/export/vat-01gtgt.xml). The layout,
// the values and their sources are in domain/vat-01gtgt-xml.ts and docs/integrations/htkk-01gtgt-xml.md.
import { vietnamToday } from '@crove/kernel-contract';
import { DomainError } from '@crove/kernel-runtime';
import { HtkkAmountError, buildForm01Xml, type Vat01Values } from './domain/vat-01gtgt-xml.ts';
import type { VatDeclaration } from './vat.ts';

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
