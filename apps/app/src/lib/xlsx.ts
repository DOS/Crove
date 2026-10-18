// A small reader and writer for .xlsx files, in the browser (issue #320). Spreadsheets a user picks are read here,
// never on the server: the kernel image parses no untrusted document (External-tenant gate T12, crove-extract holds
// the parsers), so the server only receives the cells as text. The reader covers what Excel, LibreOffice and Google
// Sheets write for a plain table: the zip container (stored or deflated entries), the first sheet, shared and inline
// strings and number cells. The writer makes the template: stored entries, inline strings, no formulas.
// Limits: a file of at most MAX_XLSX_BYTES, and every part read inflates to at most MAX_PART_BYTES, so a zip bomb
// stops early instead of filling the tab's memory.

export const MAX_XLSX_BYTES = 5 * 1024 * 1024;
const MAX_PART_BYTES = 20 * 1024 * 1024;

export class XlsxError extends Error {
  readonly reason: 'not_xlsx' | 'too_large' | 'unsupported';
  constructor(reason: XlsxError['reason'], message: string) {
    super(message);
    this.name = 'XlsxError';
    this.reason = reason;
  }
}

// A cell as stored: a number cell keeps the exact text of its stored value ("1500000", "1.5E+16"), never a JS number.
export interface SheetCell {
  kind: 'number' | 'text';
  value: string;
}

// Rows by their 1-based number; cells by 0-based column (A = 0). Missing cells are absent.
export type SheetRows = Map<number, Map<number, SheetCell>>;

// ---------------------------------------------------------------------------------------------------------------
// Zip

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

function zipEntries(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end of central directory record is in the last 22 + 65535 bytes (its comment is at most 65535 bytes).
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === SIG_END) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new XlsxError('not_xlsx', 'no zip directory');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (count === 0xffff || at === 0xffffffff) throw new XlsxError('unsupported', 'zip64 is not supported');
  const decoder = new TextDecoder();
  const entries = new Map<string, ZipEntry>();
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== SIG_CENTRAL) throw new XlsxError('not_xlsx', 'broken zip directory');
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    entries.set(name, {
      name,
      method: view.getUint16(at + 10, true),
      compressedSize: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      offset: view.getUint32(at + 42, true),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PART_BYTES) {
      await reader.cancel();
      throw new XlsxError('too_large', 'a part of the file is too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function readEntry(bytes: Uint8Array, entry: ZipEntry): Promise<string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (entry.offset + 30 > bytes.length || view.getUint32(entry.offset, true) !== SIG_LOCAL) throw new XlsxError('not_xlsx', 'broken zip entry');
  if (entry.size > MAX_PART_BYTES) throw new XlsxError('too_large', 'a part of the file is too large');
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (data.length !== entry.compressedSize) throw new XlsxError('not_xlsx', 'truncated zip entry');
  let raw: Uint8Array;
  if (entry.method === 0) raw = data;
  else if (entry.method === 8) raw = await inflateRaw(data);
  else throw new XlsxError('unsupported', `zip method ${entry.method}`);
  return new TextDecoder().decode(raw);
}

// CRC-32 (IEEE), for the entries the writer stores.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// A zip of stored (uncompressed) entries, UTF-8 names.
export function zipStored(files: ReadonlyArray<{ name: string; data: Uint8Array }>): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, SIG_LOCAL, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(12, 0x21, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, file.data.length, true);
    lv.setUint32(22, file.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const header = new Uint8Array(46 + name.length);
    const cv = new DataView(header.buffer);
    cv.setUint32(0, SIG_CENTRAL, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, file.data.length, true);
    cv.setUint32(24, file.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    header.set(name, 46);
    parts.push(local, file.data);
    central.push(header);
    offset += local.length + file.data.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, SIG_END, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const part of [...parts, ...central, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// SpreadsheetML

// Element names without their namespace prefix (<x:c> as <c>), so one set of patterns reads every writer's output.
const unprefix = (xml: string) => xml.replace(/<(\/?)[A-Za-z_][\w.-]*:/g, '<$1');

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, entity: string) => {
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'amp') return '&';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    const code = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

function attributes(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of tag.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out.set(m[1] as string, decodeXml(m[2] ?? m[3] ?? ''));
  return out;
}

// The elements named `name` in `xml`, in order: their attribute text and inner text (null when self-closing). A scan
// with indexOf, not a lazy regex: on a crafted part with many unterminated tags a regex rescans to the end for each
// one (quadratic, #366), while here an element without its closing tag ends the scan. No element read here nests
// inside one of its own name.
function* elements(xml: string, name: string): Generator<{ attrs: string; body: string | null }> {
  const open = `<${name}`;
  const close = `</${name}>`;
  let at = 0;
  for (;;) {
    const start = xml.indexOf(open, at);
    if (start < 0) return;
    const next = start + open.length;
    // `<c` must not be the start of `<cols` or `<cfRule`.
    if (!/[\s/>]/.test(xml.charAt(next))) {
      at = next;
      continue;
    }
    const end = xml.indexOf('>', next);
    if (end < 0) return;
    if (xml.charAt(end - 1) === '/') {
      yield { attrs: xml.slice(next, end - 1), body: null };
      at = end + 1;
      continue;
    }
    const closeAt = xml.indexOf(close, end + 1);
    if (closeAt < 0) return;
    yield { attrs: xml.slice(next, end), body: xml.slice(end + 1, closeAt) };
    at = closeAt + close.length;
  }
}

// `xml` without its <rPh> elements (phonetic runs), in one scan.
function withoutPhonetics(xml: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const start = xml.indexOf('<rPh', at);
    if (start < 0) return out + xml.slice(at);
    const closeAt = xml.indexOf('</rPh>', start);
    if (closeAt < 0) return out + xml.slice(at, start);
    out += xml.slice(at, start);
    at = closeAt + '</rPh>'.length;
  }
}

// The text of a string item or inline string: every <t> run, phonetic runs (<rPh>) left out.
function runText(xml: string): string {
  let out = '';
  for (const t of elements(withoutPhonetics(xml), 't')) out += decodeXml(t.body ?? '');
  return out;
}

function sharedStrings(xml: string): string[] {
  return [...elements(unprefix(xml), 'si')].map((si) => runText(si.body ?? ''));
}

// "AB12" -> column 27 (0-based), row 12.
function cellRef(ref: string): { col: number; row: number } | null {
  const m = /^([A-Z]{1,3})(\d+)$/.exec(ref.toUpperCase());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1] as string) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) };
}

function sheetRows(xml: string, strings: readonly string[]): SheetRows {
  const rows: SheetRows = new Map();
  let nextRow = 1;
  for (const row of elements(unprefix(xml), 'row')) {
    const rowAttrs = attributes(row.attrs);
    const rowNo = Number(rowAttrs.get('r') ?? nextRow);
    nextRow = rowNo + 1;
    const cells = new Map<number, SheetCell>();
    let nextCol = 0;
    for (const c of elements(row.body ?? '', 'c')) {
      const attrs = attributes(c.attrs);
      const ref = attrs.get('r');
      const col = (ref ? cellRef(ref)?.col : undefined) ?? nextCol;
      nextCol = col + 1;
      const body = c.body ?? '';
      const type = attrs.get('t') ?? 'n';
      const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
      const value = v ? decodeXml(v[1] as string) : null;
      let cell: SheetCell | null = null;
      if (type === 's') cell = value === null ? null : { kind: 'text', value: strings[Number(value)] ?? '' };
      else if (type === 'inlineStr') cell = { kind: 'text', value: runText(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '') };
      else if (type === 'n') cell = value === null ? null : { kind: 'number', value: value.trim() };
      // A boolean as the word Excel shows, so it never reads as the amount 1 or 0; error and date cells as stored.
      else if (type === 'b') cell = value === null ? null : { kind: 'text', value: value.trim() === '1' ? 'TRUE' : 'FALSE' };
      else if (value !== null) cell = { kind: 'text', value };
      if (cell) cells.set(col, cell);
    }
    if (cells.size > 0) rows.set(rowNo, cells);
  }
  return rows;
}

// The path of the workbook's first sheet, through the workbook relationships.
function firstSheetPath(workbook: string | null, rels: string | null): string {
  const fallback = 'xl/worksheets/sheet1.xml';
  if (!workbook || !rels) return fallback;
  const sheet = /<sheet\b([^>]*?)\/?>/.exec(unprefix(workbook));
  if (!sheet) return fallback;
  const attrs = attributes(sheet[1] ?? '');
  const id = [...attrs].find(([key]) => key === 'id' || key.endsWith(':id'))?.[1];
  if (!id) return fallback;
  for (const m of unprefix(rels).matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const rel = attributes(m[1] ?? '');
    if (rel.get('Id') !== id) continue;
    const target = rel.get('Target') ?? '';
    return target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  }
  return fallback;
}

// The cells of the first sheet of an .xlsx file.
export async function readFirstSheet(file: Uint8Array): Promise<SheetRows> {
  if (file.byteLength > MAX_XLSX_BYTES) throw new XlsxError('too_large', 'file too large');
  const entries = zipEntries(file);
  const text = async (name: string) => {
    const entry = entries.get(name);
    return entry ? readEntry(file, entry) : null;
  };
  const sheetPath = firstSheetPath(await text('xl/workbook.xml'), await text('xl/_rels/workbook.xml.rels'));
  const sheet = await text(sheetPath);
  if (sheet === null) throw new XlsxError('not_xlsx', 'no worksheet');
  const strings = await text('xl/sharedStrings.xml');
  return sheetRows(sheet, strings ? sharedStrings(strings) : []);
}

// ---------------------------------------------------------------------------------------------------------------
// Writer

export interface WorksheetSpec {
  name: string;
  // Column widths in characters.
  widths: number[];
  // Each cell is text; header rows are bold. Columns listed in textColumns use the Text format, so a typed code such
  // as 0111 keeps its zero; amountColumns use #,##0.
  rows: ReadonlyArray<ReadonlyArray<string>>;
  headerRows: number;
  textColumns?: readonly number[];
  amountColumns?: readonly number[];
  // Empty rows below the data that still carry the column formats.
  formattedBlankRows?: number;
}

// XML 1.0 allows no control characters but tab, line feed and carriage return; they are dropped.
const xmlChars = (text: string) =>
  Array.from(text)
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
    })
    .join('');

const escapeXml = (text: string) =>
  xmlChars(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function columnName(col: number): string {
  let name = '';
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

// Styles: 0 default, 1 bold, 2 text format (@), 3 #,##0.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function worksheetXml(spec: WorksheetSpec): string {
  const styleOf = (row: number, col: number) => {
    if (row < spec.headerRows) return 1;
    if (spec.textColumns?.includes(col)) return 2;
    if (spec.amountColumns?.includes(col)) return 3;
    return 0;
  };
  const columns = Math.max(spec.widths.length, ...spec.rows.map((r) => r.length));
  const lines: string[] = [];
  const total = spec.rows.length + (spec.formattedBlankRows ?? 0);
  for (let r = 0; r < total; r++) {
    const values = spec.rows[r] ?? [];
    const cells: string[] = [];
    for (let c = 0; c < columns; c++) {
      const ref = `${columnName(c)}${r + 1}`;
      const style = styleOf(r, c);
      const value = values[c] ?? '';
      if (value === '') {
        if (style !== 0) cells.push(`<c r="${ref}" s="${style}"/>`);
      } else {
        cells.push(`<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`);
      }
    }
    lines.push(`<row r="${r + 1}">${cells.join('')}</row>`);
  }
  const cols = spec.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const frozen =
    spec.headerRows > 0
      ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${spec.headerRows}" topLeftCell="A${spec.headerRows + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
      : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${frozen}${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${lines.join('')}</sheetData></worksheet>`;
}

// An .xlsx workbook with the given sheets, the first one active.
export function writeWorkbook(sheets: readonly WorksheetSpec[]): Uint8Array {
  const encoder = new TextEncoder();
  const file = (name: string, text: string) => ({ name, data: encoder.encode(text) });
  const ns = 'http://schemas.openxmlformats.org';
  return zipStored([
    file(
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="${ns}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets
        .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join('')}</Types>`,
    ),
    file(
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${ns}/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    file(
      'xl/workbook.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${ns}/spreadsheetml/2006/main" xmlns:r="${ns}/officeDocument/2006/relationships"><sheets>${sheets
        .map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join('')}</sheets></workbook>`,
    ),
    file(
      'xl/_rels/workbook.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${ns}/package/2006/relationships">${sheets
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${ns}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join('')}<Relationship Id="rId${sheets.length + 1}" Type="${ns}/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    file('xl/styles.xml', STYLES),
    ...sheets.map((s, i) => file(`xl/worksheets/sheet${i + 1}.xml`, worksheetXml(s))),
  ]);
}
