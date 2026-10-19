// The HTKK XML of form 01/GTGT for a period's VAT working (issue #332, GET /api/export/vat-01gtgt.xml). The layout,
// the values and their sources are in domain/vat-01gtgt-xml.ts and docs/integrations/htkk-01gtgt-xml.md.
import { buildForm01Xml, vietnamToday } from './domain/vat-01gtgt-xml.ts';
import type { VatDeclaration } from './vat.ts';

export function buildVat01Xml(declaration: VatDeclaration, today: string = vietnamToday()): string {
  return buildForm01Xml({ period: declaration.report.period, indicators: declaration.report.indicators }, declaration.taxpayer, { today });
}
