// The HTKK XML of form 01/GTGT (issue #332): the indicator values and formulas, month and quarter periods, the
// element order of HTKK's 01/GTGT 2.8.3 template, escaping, and well-formed output. GDT's schema files are not vendored
// (their licence is not stated, see docs/integrations/htkk-01gtgt-xml.md); the expected element order below is written
// out from them. Set HTKK_XML_OUT to a directory to also write the samples, for validating them against the XSD of an
// HTKK install.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { escapeXml, serializeXml, el } from '../src/domain/xml.ts';
import {
  FORM_01_CODES,
  HTKK_01GTGT,
  buildForm01Xml,
  buildVat01Xml,
  form01Indicators,
  form01XmlValues,
  sideTotals,
  vatPeriod,
  type FormIndicator,
  type VatDeclaration,
  type VatInvoiceView,
} from '../src/index.ts';

function invoice(id: string, rates: VatInvoiceView['rates']): VatInvoiceView {
  return { id, issueDate: '2026-09-15', postingDate: '2026-09-15', series: 'C26TAB', number: id, partyName: 'Công ty TNHH ABC', partyTaxCode: '0101234564', subtotal: '0', vatAmount: '0', total: '0', rates, warnings: [] };
}

function declaration(period: string, input: VatInvoiceView[], output: VatInvoiceView[], name = 'Công ty TNHH Crove Demo', address: string | null = null): VatDeclaration {
  const inputSide = { available: true, documents: input, totals: sideTotals(input) };
  const outputSide = { available: true, documents: output, totals: sideTotals(output) };
  return {
    report: { period: vatPeriod(period), input: inputSide, output: outputSide, indicators: form01Indicators(inputSide.totals, outputSide.totals), paymentChecks: { items: [], vatAtRisk: '0', notDeductibleVat: '0', unchecked: 0, suggested25: inputSide.totals.vat }, carryForward: { amount: '0', previous: null, lookedFor: [] }, filed: null },
    taxpayer: { taxCode: '0101234564', name, address },
  };
}

const purchases = [invoice('p1', [{ rate: '10', taxable: '1800000', vat: '180000' }]), invoice('p2', [{ rate: '8', taxable: '500000', vat: '40000' }])];
const sales = [
  invoice('s1', [
    { rate: '10', taxable: '10000000', vat: '1000000' },
    { rate: '5', taxable: '2000000', vat: '100000' },
  ]),
  invoice('s2', [{ rate: '8', taxable: '3000000', vat: '240000' }]),
  invoice('s3', [{ rate: '0', taxable: '4000000', vat: '0' }]),
  invoice('s4', [{ rate: 'KCT', taxable: '700000', vat: '0' }]),
  invoice('s5', [{ rate: 'KKKNT', taxable: '300000', vat: '0' }]),
];

// A strict reader for the XML this writer produces (no comments, CDATA or processing instructions besides the
// declaration): every tag balanced, one root, every '&' an XML entity, no '<' or '>' in text or attribute values. It
// returns the element paths in document order, the way HTKK's template lists them, and the decoded text of each leaf.
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
    const [, close, name = '', attrs = '', selfClose] = m;
    if (attrs.replace(ENTITY, '').includes('&')) throw new Error(`bad attribute: ${attrs}`);
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
const paths = (xml: string) => read(xml).paths;
const valueOf = (xml: string, tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1];

// The element order of HTKK's 01_GTGT_TT80_xml_283.xml template (without the optional DLyThue and PLuc blocks).
const HEAD = 'HSoThueDTu/HSoKhaiThue';
const TT = `${HEAD}/TTinChung`;
const TK = `${TT}/TTinTKhaiThue/TKhaiThue`;
const NNT = `${TT}/TTinTKhaiThue/NNT`;
const CT = `${HEAD}/CTieuTKhaiChinh`;
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
  ...['ma_NganhNghe', 'ten_NganhNghe', 'tieuMucHachToan', 'Header', 'Header/ct09', 'Header/ct10', 'Header/DiaChiHDSXKDKhacTinhNDTSC'].map((n) => `${CT}/${n}`),
  ...['ct11a_phuongXa_ma', 'ct11a_phuongXa_ten', 'ct11b_quanHuyen_ma', 'ct11b_quanHuyen_ten', 'ct11c_tinhTP_ma', 'ct11c_tinhTP_ten'].map(
    (n) => `${CT}/Header/DiaChiHDSXKDKhacTinhNDTSC/${n}`,
  ),
  ...[
    'ct21',
    'ct22',
    'GiaTriVaThueGTGTHHDVMuaVao',
    'GiaTriVaThueGTGTHHDVMuaVao/ct23',
    'GiaTriVaThueGTGTHHDVMuaVao/ct24',
    'HangHoaDichVuNhapKhau',
    'HangHoaDichVuNhapKhau/ct23a',
    'HangHoaDichVuNhapKhau/ct24a',
    'ct25',
    'ct26',
    'HHDVBRaChiuThueGTGT',
    'HHDVBRaChiuThueGTGT/ct27',
    'HHDVBRaChiuThueGTGT/ct28',
    'ct29',
    'HHDVBRaChiuTSuat5',
    'HHDVBRaChiuTSuat5/ct30',
    'HHDVBRaChiuTSuat5/ct31',
    'HHDVBRaChiuTSuat10',
    'HHDVBRaChiuTSuat10/ct32',
    'HHDVBRaChiuTSuat10/ct33',
    'ct32a',
    'TongDThuVaThueGTGTHHDVBRa',
    'TongDThuVaThueGTGTHHDVBRa/ct34',
    'TongDThuVaThueGTGTHHDVBRa/ct35',
    'ct36',
    'ct37',
    'ct38',
    'ct39a',
    'ct40a',
    'ct40b',
    'ct40',
    'ct41',
    'ct42',
    'ct43',
  ].map((n) => `${CT}/${n}`),
];

const samples: Record<string, string> = {};
function build(name: string, d: VatDeclaration, deductInput = false): string {
  const xml = buildVat01Xml(d, '2026-10-19', { deductInput });
  samples[name] = xml;
  const out = process.env.HTKK_XML_OUT;
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `${name}.xml`), xml, 'utf8');
  }
  return xml;
}

describe('form01XmlValues', () => {
  it('maps the computed indicators and works out the payable VAT with the form formulas', () => {
    const d = declaration('2026-09', purchases, sales);
    const v = form01XmlValues(d.report.indicators);
    expect(Object.keys(v).sort()).toEqual([...FORM_01_CODES].sort());
    expect(v).toMatchObject({
      '21': '0',
      '22': '0',
      '23': '2300000',
      '24': '220000',
      '23a': '0',
      '24a': '0',
      '25': '0',
      '26': '700000',
      '29': '4000000',
      '30': '2000000',
      '31': '100000',
      // 10% and the reduced 8% together.
      '32': '13000000',
      '33': '1240000',
      '32a': '300000',
      // [27] = [29] + [30] + [32] + [32a]; [28] = [31] + [33]; [34] = [26] + [27]; [35] = [28].
      '27': '19300000',
      '28': '1340000',
      '34': '20000000',
      '35': '1340000',
      // [25] is the accountant's, so [36] = [35] - 0 and all of it is payable until [25] is entered.
      '36': '1340000',
      '40a': '1340000',
      '40b': '0',
      '40': '1340000',
      '41': '0',
      '43': '0',
    });
  });

  it('carries a negative balance into [41] as a positive amount and never writes a negative [40a]', () => {
    const v = form01XmlValues([
      { code: '35', label: '', amount: '-500' },
      { code: '28', label: '', amount: '-500' },
      { code: '31', label: '', amount: '-500' },
    ]);
    expect(v['36']).toBe('-500');
    expect(v['40a']).toBe('0');
    expect(v['40']).toBe('0');
    expect(v['41']).toBe('500');
    expect(v['43']).toBe('500');
  });

  it('rounds half up to whole dong before the totals, so the totals add up in the file', () => {
    const indicators: FormIndicator[] = [
      { code: '30', label: '', amount: '100.5' },
      { code: '31', label: '', amount: '5.49' },
      { code: '32', label: '', amount: '200.5' },
      { code: '33', label: '', amount: '20.05' },
      { code: '27', label: '', amount: '301' },
      { code: '28', label: '', amount: '25.54' },
    ];
    const v = form01XmlValues(indicators);
    expect([v['30'], v['31'], v['32'], v['33']]).toEqual(['101', '5', '201', '20']);
    expect(v['27']).toBe('302');
    expect(v['28']).toBe('25');
    expect(v['34']).toBe('302');
  });

  it('ignores the indicators Crove does not compute and refuses amounts HTKK cannot hold', () => {
    expect(form01XmlValues([{ code: '25', label: '', amount: '999' }])['25']).toBe('0');
    expect(() => form01XmlValues([{ code: '23', label: '', amount: '100000000000000' }])).toThrow(/HTKK/);
    // Through the export, a refusal the user can read (422), not a server error.
    const d = declaration('2026-09', [invoice('big', [{ rate: '10', taxable: '100000000000000', vat: '0' }])], []);
    expect(() => buildVat01Xml(d, '2026-10-19')).toThrow(expect.objectContaining({ code: 'INVALID', status: 422 }));
  });

  it('refuses a taxpayer whose name is empty once trimmed, with a 422', () => {
    for (const name of ['', '   ', '\n\t ']) {
      expect(() => buildVat01Xml(declaration('2026-09', purchases, sales, name), '2026-10-19'), JSON.stringify(name)).toThrow(
        expect.objectContaining({ code: 'TAXPAYER_NAME_REQUIRED', status: 422 }),
      );
    }
  });
});

describe('buildVat01Xml', () => {
  it('writes a well-formed return in the element order of HTKK 01/GTGT 2.8.3', () => {
    const xml = build('month', declaration('2026-09', purchases, sales));
    expect(paths(xml)).toEqual(EXPECTED_ORDER);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<HSoThueDTu xmlns="http://kekhaithue.gdt.gov.vn/TKhaiThue"')).toBe(true);
    expect(xml).toContain('<HSoKhaiThue id="ID_1">');
    expect(valueOf(xml, 'maTKhai')).toBe(HTKK_01GTGT.formCode);
    expect(valueOf(xml, 'pbanTKhaiXML')).toBe('2.8.3');
    expect(valueOf(xml, 'loaiTKhai')).toBe('C');
    expect(valueOf(xml, 'soLan')).toBe('0');
    expect(valueOf(xml, 'mst')).toBe('0101234564');
    expect(valueOf(xml, 'tenNNT')).toBe('Công ty TNHH Crove Demo');
    expect(valueOf(xml, 'tieuMucHachToan')).toBe('1701');
    expect(valueOf(xml, 'ngayLapTKhai')).toBe('2026-10-19');
    expect(valueOf(xml, 'ngayKy')).toBe('2026-10-19');
    expect(valueOf(xml, 'ct32')).toBe('13000000');
    expect(valueOf(xml, 'ct40')).toBe('1340000');
  });

  it('writes a month as MM/YYYY and a quarter as Q/YYYY with its months', () => {
    const month = build('month-empty', declaration('2026-02', [], []));
    expect([valueOf(month, 'kieuKy'), valueOf(month, 'kyKKhai'), valueOf(month, 'kyKKhaiTuNgay'), valueOf(month, 'kyKKhaiDenNgay')]).toEqual([
      'M',
      '02/2026',
      '01/02/2026',
      '28/02/2026',
    ]);
    expect(month).toContain('<kyKKhaiTuThang/>');
    expect(month).toContain('<kyKKhaiDenThang/>');
    expect(valueOf(month, 'ct23')).toBe('0');

    const quarter = build('quarter', declaration('2026-Q3', purchases, sales));
    expect(
      ['kieuKy', 'kyKKhai', 'kyKKhaiTuNgay', 'kyKKhaiDenNgay', 'kyKKhaiTuThang', 'kyKKhaiDenThang'].map((tag) => valueOf(quarter, tag)),
    ).toEqual(['Q', '3/2026', '01/07/2026', '30/09/2026', '07/2026', '09/2026']);
    const q4 = buildVat01Xml(declaration('2025-Q4', [], []), '2026-01-20');
    expect([valueOf(q4, 'kyKKhai'), valueOf(q4, 'kyKKhaiTuThang'), valueOf(q4, 'kyKKhaiDenThang')]).toEqual(['4/2025', '10/2025', '12/2025']);
  });

  it('escapes the org name and keeps it on one line', () => {
    const xml = build('escaping', declaration('2026-09', [], [], 'Công ty <A> & "B"\n  \'C\']]>\u0001'));
    expect(paths(xml)).toEqual(EXPECTED_ORDER);
    expect(xml).toContain('<tenNNT>Công ty &lt;A&gt; &amp; &quot;B&quot; &apos;C&apos;]]&gt;</tenNNT>');
    expect(read(xml).text.get(`${NNT}/tenNNT`)).toBe(`Công ty <A> & "B" 'C']]>`);
  });

  it('writes the org address as one line when it has one, and an empty dchiNNT otherwise (#692)', () => {
    const none = build('month', declaration('2026-09', purchases, sales));
    expect(none).toContain('<dchiNNT/>');
    const xml = build('address', declaration('2026-09', purchases, sales, 'Công ty TNHH Crove Demo', 'Số 1 Đường A,\n  Phường B & C, TP <Hà Nội>'));
    expect(paths(xml)).toEqual(EXPECTED_ORDER);
    expect(read(xml).text.get(`${NNT}/dchiNNT`)).toBe('Số 1 Đường A, Phường B & C, TP <Hà Nội>');
    // The other address and contact parts stay empty: Crove holds the address as one line.
    for (const tag of ['phuongXa', 'tenHuyenNNT', 'tenTinhNNT', 'dthoaiNNT', 'emailNNT']) expect(xml).toContain(`<${tag}/>`);
  });

  it('puts [24] in [25] only when asked, and works the payable VAT out from it (#692)', () => {
    const d = declaration('2026-09', purchases, sales);
    expect(valueOf(build('month', d), 'ct25')).toBe('0');
    const xml = build('deduct', d, true);
    expect(paths(xml)).toEqual(EXPECTED_ORDER);
    expect(['ct24', 'ct25', 'ct35', 'ct36', 'ct40a', 'ct40', 'ct41'].map((tag) => valueOf(xml, tag))).toEqual(['220000', '220000', '1340000', '1120000', '1120000', '1120000', '0']);
    // More input than output VAT: the rest is carried forward in [41] and [43], never a negative [40a].
    const v = form01XmlValues(declaration('2026-09', purchases, []).report.indicators, { deductInput: true });
    expect([v['25'], v['36'], v['40a'], v['40'], v['41'], v['43']]).toEqual(['220000', '-220000', '0', '0', '220000', '220000']);
    // [25] takes [24] as rounded in the file, so [36] = [35] - [25] holds to the dong.
    const rounded = form01XmlValues(
      [
        { code: '24', label: '', amount: '100.5' },
        { code: '33', label: '', amount: '300' },
      ],
      { deductInput: true },
    );
    expect([rounded['24'], rounded['25'], rounded['36']]).toEqual(['101', '101', '199']);
  });

  it('puts the suggested [25] when given, rounded to the dong, over the all-of-[24] choice (#917)', () => {
    const indicators = declaration('2026-09', purchases, sales).report.indicators;
    // [24] is 220000; 40000 of it was marked not deductible.
    const v = form01XmlValues(indicators, { deductible: '180000', deductInput: true });
    expect([v['24'], v['25'], v['35'], v['36']]).toEqual(['220000', '180000', '1340000', '1160000']);
    expect(form01XmlValues(indicators, { deductible: '180000.5' })['25']).toBe('180001');
  });

  it('refuses a taxpayer without a valid tax code and a malformed date', () => {
    const d = declaration('2026-09', [], []);
    expect(() => buildForm01Xml({ period: d.report.period, indicators: [] }, { taxCode: '', name: 'X' }, { today: '2026-10-19' })).toThrow(/tax code/);
    expect(() => buildForm01Xml({ period: d.report.period, indicators: [] }, { taxCode: '0101234564', name: 'X' }, { today: '19/10/2026' })).toThrow(/date/);
    expect(buildForm01Xml({ period: d.report.period, indicators: [] }, { taxCode: '0101234564-001', name: 'X' }, { today: '2026-10-19' })).toContain('<mst>0101234564-001</mst>');
  });
});

describe('serializeXml', () => {
  it('escapes text and attributes, drops characters XML cannot hold and refuses bad element names', () => {
    expect(escapeXml('a&b<c>d"e\'f\tg\rh\u0000i￾j')).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f&#9;g&#13;hij');
    // A lone surrogate is dropped; a pair (an emoji) is kept.
    expect(escapeXml('x\uD800y😀z')).toBe('xy😀z');
    expect(serializeXml(el('r', [el('a', ''), el('b', 'x', [['k', '"<v>"']])]))).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<r>\n  <a/>\n  <b k="&quot;&lt;v&gt;&quot;">x</b>\n</r>\n');
    expect(() => serializeXml(el('a b'))).toThrow(/XML name/);
    expect(() => serializeXml(el('x', [el('<y>')]))).toThrow(/XML name/);
  });
});
