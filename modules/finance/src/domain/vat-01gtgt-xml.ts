// The VAT working of a month or a quarter (issue #316) as the XML of form 01/GTGT that HTKK reads and eTax accepts
// (issue #332). Pure functions: the indicator values, then the document.
//
// The layout is the one HTKK writes for 01/GTGT of Circular 80/2021 (form code 842, XML version 2.8.3): GDT's
// envelope schema TKhaiThue.xsd, the form schema 01_GTGT_TT80_283.xsd and HTKK's serialization template, which fixes
// the element order. Circular 89/2026 replaced Circular 80 from the July 2026 period, but as of HTKK 5.8.1
// (2026-10-16) GDT has not released an XML version of its 01/GTGT, and Circular 89 keeps the current electronic
// forms until the tax authority announces new ones. docs/integrations/htkk-01gtgt-xml.md lists every source and which
// facts are confirmed. The form constants are data (HTKK_01GTGT), so a new HTKK release is a change to the data.
//
// Crove fills what it computes from invoices ([23], [24], [26] to [35], see form01Indicators) and the form's formulas
// that follow from them. What needs the accountant's judgement or the previous return is 0: [21], [22], [23a], [24a],
// [25] (so [36] equals [35] until the accountant enters it), [37], [38], [39a], [40b] and [42]. So are the tax
// office, the signer and the address, which Crove does not hold. The accountant completes them in HTKK before filing.
import { Decimal, money, type DecimalValue, type Money } from '@crove/l10n-vn';
import { el, serializeXml, type XmlElement } from './xml.ts';
import type { FormIndicator, VatPeriod } from './vat-return.ts';

export const HTKK_01GTGT = {
  namespace: 'http://kekhaithue.gdt.gov.vn/TKhaiThue',
  formCode: '842',
  formName: 'TỜ KHAI THUẾ GIÁ TRỊ GIA TĂNG (Mẫu số 01/GTGT)',
  formBasis: '(Ban hành kèm theo Thông tư số 80/2021/TT-BTC ngày 29 tháng 9 năm 2021 của Bộ trưởng Bộ Tài chính)',
  xmlVersion: '2.8.3',
  // The software that made the file. GDT's own services name themselves here (a return filed through the public
  // service portal reads "TTGQ TTHC"); Crove names itself rather than pose as HTKK.
  service: { code: 'CROVE', name: 'Crove', version: '1.0' },
  // [01a] Ordinary production and business, the default line of business of the form.
  businessLine: { code: '00', name: 'Hoạt động sản xuất kinh doanh thông thường' },
  // The budget sub-item of domestic VAT.
  budgetSubItem: '1701',
} as const;

// Upper bound of an amount cell in HTKK (14 digits).
export const HTKK_AMOUNT_LIMIT = '99999999999999';

// An indicator beyond what HTKK holds: the caller turns it into a refusal the user can read.
export class HtkkAmountError extends Error {
  readonly code: string;
  constructor(code: string, value: string) {
    super(`indicator [${code}] exceeds what HTKK can hold: ${value}`);
    this.name = 'HtkkAmountError';
    this.code = code;
  }
}

// Indicator codes of the form, in the form's order, with the value Crove writes for each.
export const FORM_01_CODES = [
  '21', '22', '23', '24', '23a', '24a', '25', '26', '27', '28', '29', '30', '31', '32', '33', '32a', '34', '35', '36',
  '37', '38', '39a', '40a', '40b', '40', '41', '42', '43',
] as const;
export type Form01Code = (typeof FORM_01_CODES)[number];

// The indicators Crove computes from invoices; the others start at 0 (see the header).
const COMPUTED: ReadonlySet<string> = new Set(['23', '24', '26', '27', '28', '29', '30', '31', '32', '33', '32a', '34', '35']);

export interface Vat01Input {
  period: VatPeriod;
  indicators: ReadonlyArray<FormIndicator>;
}

export interface Vat01Taxpayer {
  taxCode: string;
  name: string;
}

function wholeDong(value: Money | DecimalValue): DecimalValue {
  return money(value).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
}

/**
 * Every indicator of the form as a whole number of dong (a decimal string; [21] is 0, the box not ticked). The
 * computed indicators are rounded half up to whole dong, then the totals and the payable or carried-forward VAT are
 * worked out from the rounded values with the form's formulas:
 * [36] = [35] - [25]; with x = [36] - [22] + [37] - [38] - [39a]: [40a] = x when x >= 0, [41] = -x when x < 0;
 * [40] = [40a] - [40b]; [43] = [41] - [42]. Refuses an amount HTKK cannot hold.
 */
export function form01XmlValues(indicators: ReadonlyArray<FormIndicator>): Record<Form01Code, string> {
  const v = new Map<Form01Code, DecimalValue>(FORM_01_CODES.map((code) => [code, money(0)]));
  for (const indicator of indicators) {
    if (COMPUTED.has(indicator.code)) v.set(indicator.code as Form01Code, wholeDong(indicator.amount));
  }
  const get = (code: Form01Code) => v.get(code) ?? money(0);
  // Re-derive the sums from the rounded parts, so the file obeys the form's formulas to the dong.
  v.set('27', get('29').plus(get('30')).plus(get('32')).plus(get('32a')));
  v.set('28', get('31').plus(get('33')));
  v.set('34', get('26').plus(get('27')));
  v.set('35', get('28'));
  v.set('36', get('35').minus(get('25')));
  const balance = get('36').minus(get('22')).plus(get('37')).minus(get('38')).minus(get('39a'));
  v.set('40a', balance.isNegative() ? money(0) : balance);
  v.set('41', balance.isNegative() ? balance.negated() : money(0));
  v.set('40', get('40a').minus(get('40b')));
  v.set('43', get('41').minus(get('42')));
  const out = {} as Record<Form01Code, string>;
  for (const code of FORM_01_CODES) {
    const value = get(code);
    if (value.abs().greaterThan(HTKK_AMOUNT_LIMIT)) throw new HtkkAmountError(code, value.toFixed());
    // toFixed(0) never writes an exponent; plus(0) turns a negative zero into 0.
    out[code] = value.plus(0).toFixed(0);
  }
  return out;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

// "2026-09-30" as "30/09/2026".
function dayMonthYear(date: string): string {
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}

// The period block: a month as MM/YYYY, a quarter as Q/YYYY with its first and last month (GDT's schema notes and a
// return GDT sent back for the fourth quarter of 2025).
function periodElements(period: VatPeriod): XmlElement[] {
  const [year, firstMonth] = period.from.split('-').map(Number) as [number, number];
  const lastMonth = Number(period.to.split('-')[1]);
  const quarter = period.kind === 'quarter';
  return [
    el('kieuKy', quarter ? 'Q' : 'M'),
    el('kyKKhai', quarter ? `${Math.ceil(firstMonth / 3)}/${year}` : `${pad2(firstMonth)}/${year}`),
    el('kyKKhaiTuNgay', dayMonthYear(period.from)),
    el('kyKKhaiDenNgay', dayMonthYear(period.to)),
    el('kyKKhaiTuThang', quarter ? `${pad2(firstMonth)}/${year}` : ''),
    el('kyKKhaiDenThang', quarter ? `${pad2(lastMonth)}/${year}` : ''),
  ];
}

export interface Vat01Options {
  // The day the file is made, YYYY-MM-DD (Vietnam time); it is the return's date and the signing date.
  today: string;
}

// Today's date in Vietnam (UTC+7, no daylight saving).
export function vietnamToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

/** The 01/GTGT return of `input.period` for `taxpayer`, as the UTF-8 XML text HTKK reads. */
export function buildForm01Xml(input: Vat01Input, taxpayer: Vat01Taxpayer, options: Vat01Options): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.today)) throw new Error(`not a date: ${JSON.stringify(options.today)}`);
  if (!/^(\d{10}(-\d{3})?|\d{12})$/.test(taxpayer.taxCode)) throw new Error('the taxpayer has no valid tax code');
  const ct = form01XmlValues(input.indicators);
  const c = (code: Form01Code) => el(`ct${code}`, ct[code]);
  const empty = (...names: string[]) => names.map((name) => el(name, ''));
  const f = HTKK_01GTGT;
  // tenNNT is an xs:token: no line breaks or runs of spaces.
  const name = taxpayer.name.replace(/\s+/g, ' ').trim();

  const general = el('TTinChung', [
    el('TTinDVu', [el('maDVu', f.service.code), el('tenDVu', f.service.name), el('pbanDVu', f.service.version), el('ttinNhaCCapDVu', '')]),
    el('TTinTKhaiThue', [
      el('TKhaiThue', [
        el('maTKhai', f.formCode),
        el('tenTKhai', f.formName),
        el('moTaBMau', f.formBasis),
        el('pbanTKhaiXML', f.xmlVersion),
        // C: a first return for the period (B would be a supplementary one).
        el('loaiTKhai', 'C'),
        el('soLan', '0'),
        el('KyKKhaiThue', periodElements(input.period)),
        ...empty('maCQTNoiNop', 'tenCQTNoiNop'),
        el('ngayLapTKhai', options.today),
        el('GiaHan', empty('maLyDoGiaHan', 'lyDoGiaHan')),
        el('nguoiKy', ''),
        el('ngayKy', options.today),
        el('nganhNgheKD', ''),
      ]),
      el('NNT', [
        el('mst', taxpayer.taxCode),
        el('tenNNT', name),
        ...empty('dchiNNT', 'phuongXa', 'maHuyenNNT', 'tenHuyenNNT', 'maTinhNNT', 'tenTinhNNT', 'dthoaiNNT', 'faxNNT', 'emailNNT'),
      ]),
    ]),
  ]);

  const main = el('CTieuTKhaiChinh', [
    el('ma_NganhNghe', f.businessLine.code),
    el('ten_NganhNghe', f.businessLine.name),
    el('tieuMucHachToan', f.budgetSubItem),
    el('Header', [
      ...empty('ct09', 'ct10'),
      el(
        'DiaChiHDSXKDKhacTinhNDTSC',
        empty('ct11a_phuongXa_ma', 'ct11a_phuongXa_ten', 'ct11b_quanHuyen_ma', 'ct11b_quanHuyen_ten', 'ct11c_tinhTP_ma', 'ct11c_tinhTP_ten'),
      ),
    ]),
    c('21'),
    c('22'),
    el('GiaTriVaThueGTGTHHDVMuaVao', [c('23'), c('24')]),
    el('HangHoaDichVuNhapKhau', [c('23a'), c('24a')]),
    c('25'),
    c('26'),
    el('HHDVBRaChiuThueGTGT', [c('27'), c('28')]),
    c('29'),
    el('HHDVBRaChiuTSuat5', [c('30'), c('31')]),
    el('HHDVBRaChiuTSuat10', [c('32'), c('33')]),
    c('32a'),
    el('TongDThuVaThueGTGTHHDVBRa', [c('34'), c('35')]),
    c('36'),
    c('37'),
    c('38'),
    c('39a'),
    c('40a'),
    c('40b'),
    c('40'),
    c('41'),
    c('42'),
    c('43'),
  ]);

  return serializeXml(
    el('HSoThueDTu', [el('HSoKhaiThue', [general, main], [['id', 'ID_1']])], [
      ['xmlns', f.namespace],
      ['xmlns:xsi', 'http://www.w3.org/2001/XMLSchema-instance'],
    ]),
  );
}
