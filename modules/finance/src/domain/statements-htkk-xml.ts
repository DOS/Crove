// The year-end financial statements of a TT133 company (issue #920) as the XML HTKK writes for the set "Bộ báo cáo tài
// chính (B01a - DNN)": the statement of financial position B01a-DNN in the main part, and the income statement B02-DNN
// and the trial balance F01-DNN as appendices. Pure functions: the values, then the document.
//
// The layout is HTKK's form 683, XML version 2.3.2: GDT's envelope schema TKhaiThue.xsd, the form schema
// 133_B01A_DNN_BCTC_232.xsd and HTKK's serialization templates (133_B01A_0x_*_xml_232.xml), which fix the element
// order. docs/integrations/htkk-bctc-xml.md lists every source and which facts are confirmed. The form constants are
// data (HTKK_BCTC), so a new HTKK release is a change to the data.
//
// Crove fills the figures from its ledger: B01 at the year's end and at the previous year's end, B02 for the year and
// the previous year (the builders of tt133-reports.ts, whose mapping an accountant still has to confirm, #154), and the
// F01 rows of HTKK's fixed account list from the year's trial balance. What Crove does not hold stays empty for the
// accountant: the note references (Thuyết minh), the audit opinion, the signers. The cash flow statement (B03-DNN) is
// optional in the schema and not written; the notes (B09-DNN) are not part of this file.
import { Decimal, money, type DecimalValue, type Money } from '@crove/l10n-vn';
import { el, serializeXml, type XmlElement } from './xml.ts';
import { HTKK_AMOUNT_LIMIT, HtkkAmountError } from './vat-01gtgt-xml.ts';
import { B01_LINES, B02_LINES, type ReportLine, type ReportLineDef } from './tt133-reports.ts';
import type { TrialBalance, TrialBalanceAmounts } from './ledger-reports.ts';

export const HTKK_BCTC = {
  namespace: 'http://kekhaithue.gdt.gov.vn/TKhaiThue',
  formCode: '683',
  formName: 'Bộ báo cáo tài chính (B01a - DNN)(TT133/2016/TT-BTC)',
  formBasis: '(Ban hành theo Thông tư số 133/2016/TT-BTC ngày 26/8/2016 của Bộ Tài chính)',
  xmlVersion: '2.3.2',
  // The software that made the file; Crove names itself rather than pose as HTKK (as for 01/GTGT).
  service: { code: 'CROVE', name: 'Crove', version: '1.0' },
} as const;

// The indicators of B01a-DNN and B02-DNN in the template's order: the line codes of tt133-reports.ts.
export const B01_CODES = [
  '110', '120', '121', '122', '123', '124', '130', '131', '132', '133', '134', '135', '136', '140', '141', '142', '150',
  '151', '152', '160', '161', '162', '170', '180', '181', '182', '200', '300', '311', '312', '313', '314', '315', '316',
  '317', '318', '319', '320', '400', '411', '412', '413', '414', '415', '416', '417', '500',
] as const;
export const B02_CODES = ['01', '02', '10', '11', '20', '21', '22', '23', '24', '30', '31', '32', '40', '50', '51', '60'] as const;

// The accounts of F01-DNN, as HTKK lists them (133_B01A_05_CDTK_xml_232.xml): the TT133 accounts of level 1 and 2.
export const F01_ACCOUNTS = [
  '111', '1111', '1112', '112', '1121', '1122', '121', '128', '1281', '1288', '131', '133', '1331', '1332', '136', '1361',
  '1368', '138', '1381', '1386', '1388', '141', '151', '152', '153', '154', '155', '156', '157', '211', '2111', '2112',
  '2113', '214', '2141', '2142', '2143', '2147', '217', '228', '2281', '2288', '229', '2291', '2292', '2293', '2294', '241',
  '2411', '2412', '2413', '242', '331', '333', '3331', '33311', '33312', '3332', '3333', '3334', '3335', '3336', '3337',
  '3338', '33381', '33382', '3339', '334', '335', '336', '3361', '3368', '338', '3381', '3382', '3383', '3384', '3385',
  '3386', '3387', '3388', '341', '3411', '3412', '352', '3521', '3522', '3524', '353', '3531', '3532', '3533', '3534', '356',
  '3561', '3562', '411', '4111', '4112', '4118', '413', '418', '419', '421', '4211', '4212', '511', '5111', '5112', '5113',
  '5118', '515', '611', '631', '632', '635', '642', '6421', '6422', '711', '811', '821', '911',
] as const;
const F01_SET: ReadonlySet<string> = new Set(F01_ACCOUNTS);
// The level-1 accounts, whose rows add up to the total (a level-2 row is already in its parent).
const F01_TOP = F01_ACCOUNTS.filter((code) => code.length === 3);

export interface StatementsYear {
  // B01's lines at the year's end, and B02's for the year (FinancialStatements of statements.ts).
  b01: ReadonlyArray<ReportLine>;
  b02: ReadonlyArray<ReportLine>;
}

export interface BctcInput {
  year: number;
  current: StatementsYear;
  // The previous year: its B01 is the "start of year" column, its B02 the "previous year" one.
  previous: StatementsYear;
  // The year's trial balance (ledger-reports.ts), rows per chart account, parents included.
  trialBalance: TrialBalance;
}

export interface BctcTaxpayer {
  taxCode: string;
  name: string;
  address?: string | null;
}

function wholeDong(value: Money | DecimalValue): DecimalValue {
  return money(value).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
}

function written(where: string, value: DecimalValue): string {
  if (value.abs().greaterThan(HTKK_AMOUNT_LIMIT)) throw new HtkkAmountError(where, value.toFixed());
  // toFixed(0) never writes an exponent; plus(0) turns a negative zero into 0.
  return value.plus(0).toFixed(0);
}

/**
 * A statement's lines as whole dong, keyed by code: each line read from accounts is rounded half up, then every total
 * is worked out again from the rounded lines with the form's formulas, so the file adds up to the dong.
 */
export function statementValues(lines: ReadonlyArray<ReportLine>, defs: readonly ReportLineDef[]): Map<string, string> {
  const given = new Map(lines.map((l) => [l.code, l.amount]));
  const v = new Map<string, DecimalValue>();
  for (const def of defs) {
    if (def.formula) v.set(def.code, def.formula.reduce((acc, [sign, code]) => acc.plus((v.get(code) ?? money(0)).times(sign)), money(0)));
    else v.set(def.code, wholeDong(given.get(def.code) ?? '0'));
  }
  return new Map([...v].map(([code, value]) => [code, written(`ct${code}`, value)]));
}

const SIDES = ['openingDebit', 'openingCredit', 'debit', 'credit', 'closingDebit', 'closingCredit'] as const;
type Side = (typeof SIDES)[number];

export interface F01Values {
  // Per side, per account of F01_ACCOUNTS, then 'tongCong'.
  values: Record<Side, Map<string, string>>;
  // Accounts with an amount that no row of HTKK's list holds, neither themselves nor an account above them: their
  // amounts are missing from the file (a non-standard top account, say).
  uncovered: string[];
}

/** The F01 rows of HTKK's list from the year's trial balance, whole dong; the total is the sum of the level-1 rows. */
export function f01Values(tb: TrialBalance): F01Values {
  const byCode = new Map(tb.rows.map((r) => [r.accountCode, r]));
  const values = Object.fromEntries(SIDES.map((side) => [side, new Map<string, string>()])) as Record<Side, Map<string, string>>;
  for (const side of SIDES) {
    let total = money(0);
    for (const code of F01_ACCOUNTS) {
      const row = byCode.get(code);
      const value = wholeDong(row ? row[side] : '0');
      values[side].set(code, written(`F01 ${code}`, value));
      if (F01_TOP.includes(code)) total = total.plus(value);
    }
    values[side].set('tongCong', written('F01 tongCong', total));
  }
  // A top-level row of the trial balance holds its sub-accounts; it is covered when it is in the list.
  const isZero = (a: TrialBalanceAmounts) => SIDES.every((side) => money(a[side]).isZero());
  const uncovered = tb.rows.filter((r) => r.level === 0 && !F01_SET.has(r.accountCode) && !isZero(r)).map((r) => r.accountCode);
  return { values, uncovered };
}

export interface BctcOptions {
  // The day the file is made, YYYY-MM-DD (Vietnam time); the return's date and the date of the statements.
  today: string;
}

/** The year's financial statements for `taxpayer` as the UTF-8 XML text HTKK reads (form 683). */
export function buildStatementsXml(input: BctcInput, taxpayer: BctcTaxpayer, options: BctcOptions): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.today)) throw new Error(`not a date: ${JSON.stringify(options.today)}`);
  if (!/^(\d{10}(-\d{3})?|\d{12})$/.test(taxpayer.taxCode)) throw new Error('the taxpayer has no valid tax code');
  if (!Number.isInteger(input.year) || input.year < 2000 || input.year > 2100) throw new Error(`not a year: ${input.year}`);
  const f = HTKK_BCTC;
  const empty = (...names: string[]) => names.map((name) => el(name, ''));
  // tenNNT and dchiNNT are xs:token: no line breaks or runs of spaces.
  const token = (text: string) => text.replace(/\s+/g, ' ').trim();
  const year = String(input.year);

  const b01End = statementValues(input.current.b01, B01_LINES);
  const b01Start = statementValues(input.previous.b01, B01_LINES);
  const b02Year = statementValues(input.current.b02, B02_LINES);
  const b02Previous = statementValues(input.previous.b02, B02_LINES);
  const f01 = f01Values(input.trialBalance).values;

  const cells = (codes: readonly string[], values: Map<string, string> | null) => codes.map((code) => el(`ct${code}`, values ? (values.get(code) ?? '0') : ''));

  const general = el('TTinChung', [
    el('TTinDVu', [el('maDVu', f.service.code), el('tenDVu', f.service.name), el('pbanDVu', f.service.version), el('ttinNhaCCapDVu', '')]),
    el('TTinTKhaiThue', [
      el('TKhaiThue', [
        el('maTKhai', f.formCode),
        el('tenTKhai', f.formName),
        el('moTaBMau', f.formBasis),
        el('pbanTKhaiXML', f.xmlVersion),
        // C: the first set for the year (B would be a supplementary one).
        el('loaiTKhai', 'C'),
        el('soLan', '0'),
        // A calendar fiscal year: kieuKy Y and kyKKhai YYYY, as TKhaiThue.xsd documents a year (unconfirmed for this
        // form, see the doc).
        el('KyKKhaiThue', [
          el('kieuKy', 'Y'),
          el('kyKKhai', year),
          el('kyKKhaiTuNgay', `01/01/${year}`),
          el('kyKKhaiDenNgay', `31/12/${year}`),
          ...empty('kyKKhaiTuThang', 'kyKKhaiDenThang'),
        ]),
        ...empty('maCQTNoiNop', 'tenCQTNoiNop'),
        el('ngayLapTKhai', options.today),
        el('GiaHan', empty('maLyDoGiaHan', 'lyDoGiaHan')),
        el('nguoiKy', ''),
        el('ngayKy', options.today),
        el('nganhNgheKD', ''),
      ]),
      el('NNT', [
        el('mst', taxpayer.taxCode),
        el('tenNNT', token(taxpayer.name)),
        el('dchiNNT', token(taxpayer.address ?? '')),
        ...empty('phuongXa', 'maHuyenNNT', 'tenHuyenNNT', 'maTinhNNT', 'tenTinhNNT', 'dthoaiNNT', 'faxNNT', 'emailNNT'),
      ]),
    ]),
  ]);

  const main = el('CTieuTKhaiChinh', [
    // xs:boolean: the statements are not audited (the accountant changes it for an audited set).
    el('bctcDaKiemToan', '0'),
    ...empty('maYKienKToan', 'tenYKienKToan'),
    el('ThuyetMinh', cells(B01_CODES, null)),
    el('SoCuoiNam', cells(B01_CODES, b01End)),
    el('SoDauNam', cells(B01_CODES, b01Start)),
    ...empty('nguoiLapBieu', 'keToanTruong'),
    // xs:date: the statements are dated the day the file is made.
    el('ngayLap', options.today),
    el('nguoiDaiDienTheoPhapLuat', ''),
  ]);

  const side = (s: Side): XmlElement[] => [...F01_ACCOUNTS.map((code) => el(`ct${code}`, f01[s].get(code) ?? '0')), el('tongCong', f01[s].get('tongCong') ?? '0')];
  const appendices = el('PLuc', [
    el('PL_KQHDSXKD', [el('ThuyetMinh', cells(B02_CODES, null)), el('NamNay', cells(B02_CODES, b02Year)), el('NamTruoc', cells(B02_CODES, b02Previous))]),
    el('PL_CDTK', [
      el('SoDuDauKy', [el('No', side('openingDebit')), el('Co', side('openingCredit'))]),
      el('SoPhatSinhTrongKy', [el('No', side('debit')), el('Co', side('credit'))]),
      el('SoDuCuoiKy', [el('No', side('closingDebit')), el('Co', side('closingCredit'))]),
    ]),
  ]);

  return serializeXml(
    el('HSoThueDTu', [el('HSoKhaiThue', [general, main, appendices], [['id', 'ID_1']])], [
      ['xmlns', f.namespace],
      ['xmlns:xsi', 'http://www.w3.org/2001/XMLSchema-instance'],
    ]),
  );
}
