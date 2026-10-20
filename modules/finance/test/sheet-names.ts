// Crove's own export sheets carry Vietnamese names with their diacritics (issue #365); sheet names an import template
// fixes (the MISA SME templates) are the template's. Either way a name must be one Excel accepts: at most 31
// characters, none of \ / ? * [ ] :, no apostrophe at either end, not the reserved "History". Names are written in
// NFC, so a name typed in a decomposed form never shows as two sheets that look alike.
import type ExcelJS from 'exceljs';
import { expect } from 'vitest';

const FORBIDDEN = /[\\/?*[\]:]/;

export function expectExcelSheetNames(workbook: ExcelJS.Workbook): void {
  for (const { name } of workbook.worksheets) {
    expect(name.length, name).toBeGreaterThan(0);
    expect(name.length, name).toBeLessThanOrEqual(31);
    expect(FORBIDDEN.test(name), name).toBe(false);
    expect(name.startsWith("'") || name.endsWith("'"), name).toBe(false);
    expect(name.toLowerCase(), name).not.toBe('history');
    expect(name.normalize('NFC'), name).toBe(name);
  }
}
