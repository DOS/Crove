// The HTKK XML of the TT133 year-end statements (issue #920, form 683): the B01a-DNN and B02-DNN values with their
// totals worked out from whole dong, the F01-DNN rows of HTKK's account list from the trial balance, the element order
// of HTKK's 2.3.2 templates, and escaping. GDT's schema files are not vendored (see docs/integrations/htkk-bctc-xml.md);
// the expected order below is written out from them. Set HTKK_XML_OUT to a directory to also write the samples, for
// validating them against the XSD of an HTKK install.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { B01_CODES, B02_CODES, F01_ACCOUNTS, HTKK_BCTC, buildStatementsXml, f01Values, statementValues, type BctcInput, type BctcTaxpayer } from '../src/domain/statements-htkk-xml.ts';
import { trialBalance, type ChartAccount, type PeriodLine } from '../src/domain/ledger-reports.ts';
import { B01_LINES, B02_LINES, type ReportLine } from '../src/domain/tt133-reports.ts';
import { HtkkAmountError } from '../src/domain/vat-01gtgt-xml.ts';

// A strict reader for the XML this writer produces, as in vat-01gtgt-xml.test.ts: every tag balanced, one root, every
// '&' an entity. It returns the element paths in document order and the decoded text of each leaf.
const ENTITY = /&(amp|lt|gt|quot|apos|#\d+);/g;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (text: string) => text.replace(ENTITY, (_, e: string) => NAMED[e] ?? String.fromCodePoint(Number(e.slice(1))));
function read(xml: string): { paths: string[]; text: Map<string, string> } {
  const body = xml.replace(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n/, '');
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+="[^"<>]*")*)\s*(\/?)>/y;
  const stack: string[] = [];
  const paths: string[] = [];
  const text = new Map<string, string>();
  let i = 0;
  let roots = 0;
  while (i < body.length) {
    const lt = body.indexOf('<', i);
    const chunk = body.slice(i, lt === -1 ? body.length : lt);
    if (chunk.includes('>') || chunk.replace(ENTITY, '').includes('&')) throw new Error(`bad text: ${chunk}`);
    if (chunk.trim()) {
      if (stack.length === 0) throw new Error(`text outside the root: ${chunk}`);
      text.set(stack.join('/'), decode(chunk));
    }
    if (lt === -1) break;
    tag.lastIndex = lt;
    const m = tag.exec(body);
    if (!m) throw new Error(`bad tag at ${lt}: ${body.slice(lt, lt + 40)}`);
    const [, close, name = '', , selfClose] = m;
    if (close) {
      if (stack.pop() !== name) throw new Error(`unbalanced </${name}>`);
    } else {
      if (stack.length === 0 && roots++ > 0) throw new Error('two roots');
      stack.push(name);
      paths.push(stack.join('/'));
      if (selfClose) stack.pop();
    }
    i = tag.lastIndex;
  }
  if (stack.length) throw new Error(`unclosed ${stack.join('/')}`);
  return { paths, text };
}

const HEAD = 'HSoThueDTu/HSoKhaiThue';
const TT = `${HEAD}/TTinChung`;
const TK = `${TT}/TTinTKhaiThue/TKhaiThue`;
const NNT = `${TT}/TTinTKhaiThue/NNT`;
const CT = `${HEAD}/CTieuTKhaiChinh`;
const PL = `${HEAD}/PLuc`;
const ct = (prefix: string, codes: readonly string[]) => codes.map((c) => `${prefix}/ct${c}`);

// The element order of HTKK's 133_B01A_01_THTC_xml_232.xml, 133_B01A_02_SXKD_xml_232.xml and
// 133_B01A_05_CDTK_xml_232.xml (without the optional DLyThue block and the cash flow appendices).
const B01_ORDER = ['110', '120', '121', '122', '123', '124', '130', '131', '132', '133', '134', '135', '136', '140', '141', '142', '150', '151', '152', '160', '161', '162', '170', '180', '181', '182', '200', '300', '311', '312', '313', '314', '315', '316', '317', '318', '319', '320', '400', '411', '412', '413', '414', '415', '416', '417', '500'];
const B02_ORDER = ['01', '02', '10', '11', '20', '21', '22', '23', '24', '30', '31', '32', '40', '50', '51', '60'];
const side = (prefix: string) => [prefix, ...ct(prefix, F01_ACCOUNTS), `${prefix}/tongCong`];
const EXPECTED_ORDER = [
  'HSoThueDTu',
  HEAD,
  TT,
  `${TT}/TTinDVu`,
  ...['maDVu', 'tenDVu', 'pbanDVu', 'ttinNhaCCapDVu'].map((n) => `${TT}/TTinDVu/${n}`),
  `${TT}/TTinTKhaiThue`,
  TK,
  ...['maTKhai', 'tenTKhai', 'moTaBMau', 'pbanTKhaiXML', 'loaiTKhai', 'soLan', 'KyKKhaiThue'].map((n) => `${TK}/${n}`),
  ...['kieuKy', 'kyKKhai', 'kyKKhaiTuNgay', 'kyKKhaiDenNgay', 'kyKKhaiTuThang', 'kyKKhaiDenThang'].map((n) => `${TK}/KyKKhaiThue/${n}`),
  ...['maCQTNoiNop', 'tenCQTNoiNop', 'ngayLapTKhai', 'GiaHan', 'GiaHan/maLyDoGiaHan', 'GiaHan/lyDoGiaHan', 'nguoiKy', 'ngayKy', 'nganhNgheKD'].map((n) => `${TK}/${n}`),
  NNT,
  ...['mst', 'tenNNT', 'dchiNNT', 'phuongXa', 'maHuyenNNT', 'tenHuyenNNT', 'maTinhNNT', 'tenTinhNNT', 'dthoaiNNT', 'faxNNT', 'emailNNT'].map((n) => `${NNT}/${n}`),
  CT,
  ...['bctcDaKiemToan', 'maYKienKToan', 'tenYKienKToan'].map((n) => `${CT}/${n}`),
  `${CT}/ThuyetMinh`,
  ...ct(`${CT}/ThuyetMinh`, B01_ORDER),
  `${CT}/SoCuoiNam`,
  ...ct(`${CT}/SoCuoiNam`, B01_ORDER),
  `${CT}/SoDauNam`,
  ...ct(`${CT}/SoDauNam`, B01_ORDER),
  ...['nguoiLapBieu', 'keToanTruong', 'ngayLap', 'nguoiDaiDienTheoPhapLuat'].map((n) => `${CT}/${n}`),
  PL,
  `${PL}/PL_KQHDSXKD`,
  `${PL}/PL_KQHDSXKD/ThuyetMinh`,
  ...ct(`${PL}/PL_KQHDSXKD/ThuyetMinh`, B02_ORDER),
  `${PL}/PL_KQHDSXKD/NamNay`,
  ...ct(`${PL}/PL_KQHDSXKD/NamNay`, B02_ORDER),
  `${PL}/PL_KQHDSXKD/NamTruoc`,
  ...ct(`${PL}/PL_KQHDSXKD/NamTruoc`, B02_ORDER),
  `${PL}/PL_CDTK`,
  ...['SoDuDauKy', 'SoPhatSinhTrongKy', 'SoDuCuoiKy'].flatMap((s) => [`${PL}/PL_CDTK/${s}`, ...side(`${PL}/PL_CDTK/${s}/No`), ...side(`${PL}/PL_CDTK/${s}/Co`)]),
];

const line = (code: string, amount: string): ReportLine => ({ code, label: code, amount });
const chart: ChartAccount[] = [
  { code: '111', name: 'Tiền mặt', parentCode: null },
  { code: '1111', name: 'Tiền Việt Nam', parentCode: '111' },
  { code: '331', name: 'Phải trả người bán', parentCode: null },
  { code: '411', name: 'Vốn đầu tư của chủ sở hữu', parentCode: null },
  { code: '4111', name: 'Vốn góp của chủ sở hữu', parentCode: '411' },
  { code: '642', name: 'Chi phí quản lý kinh doanh', parentCode: null },
  { code: '6422', name: 'Chi phí quản lý doanh nghiệp', parentCode: '642' },
  { code: '6422.DV', name: 'Dịch vụ', parentCode: '6422' },
  { code: '999', name: 'Tài khoản riêng', parentCode: null },
];
const posted = (n: number, account: string, debit: string, credit: string, partyId: string | null = null): PeriodLine => ({
  entryId: `e${n}`,
  entryDate: '2026-06-30',
  reference: null,
  description: 'test',
  reversal: false,
  lineNo: n,
  accountCode: account,
  partyId,
  debit,
  credit,
});

function input(overrides: Partial<BctcInput> = {}): BctcInput {
  return {
    year: 2026,
    current: {
      b01: [line('110', '120000000.4'), line('131', '30000000'), line('152', '-1000000'), line('151', '12000000'), line('311', '20000000'), line('411', '100000000'), line('417', '41000000.4')],
      b02: [line('01', '200000000'), line('02', '0.5'), line('11', '120000000'), line('24', '39000000')],
    },
    previous: { b01: [line('110', '100000000'), line('411', '100000000')], b02: [] },
    trialBalance: trialBalance(
      chart,
      [
        { accountCode: '1111', partyId: null, debit: '100000000', credit: '0' },
        { accountCode: '4111', partyId: null, debit: '0', credit: '100000000' },
      ],
      [posted(1, '6422.DV', '1500000', '0'), posted(2, '1111', '0', '1500000'), posted(3, '6422', '200000', '0'), posted(4, '331', '0', '200000', 'p1')],
    ),
    ...overrides,
  };
}

const taxpayer: BctcTaxpayer = { taxCode: '0101234564', name: 'Công ty TNHH Crove Demo', address: '1 Đường Mẫu, Quận 1' };
const samples: Record<string, string> = {};
function build(name: string, i: BctcInput, who = taxpayer): string {
  const xml = buildStatementsXml(i, who, { today: '2027-03-15' });
  samples[name] = xml;
  const out = process.env.HTKK_XML_OUT;
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `bctc-${name}.xml`), xml, 'utf8');
  }
  return xml;
}

describe('statementValues', () => {
  it('rounds the lines read from accounts half up, then works every total out from the rounded lines', () => {
    const b01 = statementValues(input().current.b01, B01_LINES);
    expect(b01.get('110')).toBe('120000000');
    expect(b01.get('150')).toBe('11000000');
    expect(b01.get('200')).toBe(String(120000000 + 30000000 + 11000000));
    expect(b01.get('417')).toBe('41000000');
    expect(b01.get('500')).toBe(String(20000000 + 100000000 + 41000000));
    expect([...b01.keys()].sort()).toEqual([...B01_ORDER].sort());
    const b02 = statementValues(input().current.b02, B02_LINES);
    // 0.5 rounds up to 1, so the net revenue is 199999999 and every total follows from it.
    expect(b02.get('02')).toBe('1');
    expect(b02.get('10')).toBe('199999999');
    expect(b02.get('20')).toBe('79999999');
    expect(b02.get('60')).toBe('40999999');
    expect([...b02.keys()].sort()).toEqual([...B02_ORDER].sort());
  });

  it('refuses an amount beyond what HTKK holds', () => {
    expect(() => statementValues([line('110', '100000000000000')], B01_LINES)).toThrow(HtkkAmountError);
  });
});

describe('f01Values', () => {
  it('reads HTKK accounts from the trial balance, sub-accounts inside their parent, and totals the level-1 rows', () => {
    const { values, uncovered } = f01Values(input().trialBalance);
    expect(values.openingDebit.get('111')).toBe('100000000');
    expect(values.openingDebit.get('1111')).toBe('100000000');
    expect(values.openingCredit.get('411')).toBe('100000000');
    expect(values.openingCredit.get('4111')).toBe('100000000');
    // 6422.DV is not in HTKK's list; its amounts are in 6422 and 642.
    expect(values.debit.get('6422')).toBe('1700000');
    expect(values.debit.get('642')).toBe('1700000');
    expect(values.closingCredit.get('331')).toBe('200000');
    expect(values.debit.get('tongCong')).toBe('1700000');
    expect(values.credit.get('tongCong')).toBe('1700000');
    expect(values.closingDebit.get('tongCong')).toBe(String(98500000 + 1700000));
    expect(values.closingCredit.get('tongCong')).toBe(String(100000000 + 200000));
    expect(uncovered).toEqual([]);
  });

  it('names a top account outside HTKK list whose amounts the file leaves out', () => {
    const tb = trialBalance(chart, [], [posted(1, '999', '5000', '0'), posted(2, '1111', '0', '5000')]);
    expect(f01Values(tb).uncovered).toEqual(['999']);
  });
});

describe('buildStatementsXml', () => {
  it('writes a well-formed set in the element order of HTKK form 683, XML 2.3.2', () => {
    const xml = build('year', input());
    const { paths, text } = read(xml);
    expect(paths).toEqual(EXPECTED_ORDER);
    expect([...B01_CODES]).toEqual(B01_ORDER);
    expect([...B02_CODES]).toEqual(B02_ORDER);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<HSoThueDTu xmlns="http://kekhaithue.gdt.gov.vn/TKhaiThue"')).toBe(true);
    expect(xml).toContain('<HSoKhaiThue id="ID_1">');
    expect(text.get(`${TK}/maTKhai`)).toBe(HTKK_BCTC.formCode);
    expect(text.get(`${TK}/pbanTKhaiXML`)).toBe('2.3.2');
    expect(text.get(`${TK}/KyKKhaiThue/kieuKy`)).toBe('Y');
    expect(text.get(`${TK}/KyKKhaiThue/kyKKhai`)).toBe('2026');
    expect(text.get(`${TK}/KyKKhaiThue/kyKKhaiTuNgay`)).toBe('01/01/2026');
    expect(text.get(`${TK}/KyKKhaiThue/kyKKhaiDenNgay`)).toBe('31/12/2026');
    expect(text.get(`${TK}/ngayLapTKhai`)).toBe('2027-03-15');
    expect(text.get(`${NNT}/mst`)).toBe('0101234564');
    expect(text.get(`${CT}/bctcDaKiemToan`)).toBe('0');
    expect(text.get(`${CT}/ngayLap`)).toBe('2027-03-15');
    expect(text.get(`${CT}/ThuyetMinh/ct110`)).toBeUndefined();
    expect(text.get(`${CT}/SoCuoiNam/ct200`)).toBe('161000000');
    expect(text.get(`${CT}/SoDauNam/ct110`)).toBe('100000000');
    expect(text.get(`${CT}/SoDauNam/ct500`)).toBe('100000000');
    expect(text.get(`${PL}/PL_KQHDSXKD/NamNay/ct60`)).toBe('40999999');
    expect(text.get(`${PL}/PL_KQHDSXKD/NamTruoc/ct60`)).toBe('0');
    expect(text.get(`${PL}/PL_CDTK/SoDuDauKy/No/ct1111`)).toBe('100000000');
    expect(text.get(`${PL}/PL_CDTK/SoPhatSinhTrongKy/No/ct6422`)).toBe('1700000');
    expect(text.get(`${PL}/PL_CDTK/SoDuCuoiKy/Co/tongCong`)).toBe('100200000');
  });

  it('escapes the org name and keeps it and the address on one line', () => {
    const xml = build('escape', input(), { taxCode: '0101234564', name: 'A & B <"Crove">\n  Demo', address: null });
    const { text } = read(xml);
    expect(text.get(`${NNT}/tenNNT`)).toBe('A & B <"Crove"> Demo');
    expect(text.get(`${NNT}/dchiNNT`)).toBeUndefined();
  });

  it('refuses a taxpayer without a valid tax code, a malformed date and a year out of range', () => {
    expect(() => buildStatementsXml(input(), { ...taxpayer, taxCode: '123' }, { today: '2027-03-15' })).toThrow(/tax code/);
    expect(() => buildStatementsXml(input(), taxpayer, { today: '15/03/2027' })).toThrow(/not a date/);
    expect(() => buildStatementsXml(input({ year: 1999 }), taxpayer, { today: '2027-03-15' })).toThrow(/not a year/);
  });
});
