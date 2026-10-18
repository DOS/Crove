// Reader for the first sheet of an .xlsx workbook (the tax portal's invoice list, #465). Runs only inside a parser
// process (see sandbox.ts): the workbook is untrusted. The container is opened with readZipParts, which checks the
// directory, refuses overlapping or escaping entries and caps every inflated part; only the parts a plain table needs
// are inflated (workbook, its relationships, the first sheet, shared strings, styles). DOCTYPE and ENTITY are refused
// in every part, so no entity is ever expanded, and the cell scanner is linear in the size of the sheet: it never
// builds a tree of the whole sheet in memory.
//
// What it returns is a grid of text: a number cell keeps the exact digits Excel stored ("1500000", "1.5E+16"), never
// a JS number, and a number cell whose style is a date format is marked as a date so the caller can turn the serial
// into a calendar day. Formulas are never evaluated; their cached value is read like any other.
import { XMLParser } from 'fast-xml-parser';
import { ArchiveError, readZipParts } from './zip.ts';

const MiB = 1024 * 1024;

export class XlsxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XlsxError';
  }
}

export interface XlsxLimits {
  // Each inflated part, and all of them together.
  maxPartBytes: number;
  maxTotalBytes: number;
  // Rows with at least one cell, and the highest column read (A = 1). Cells to the right are ignored.
  maxRows: number;
  maxColumns: number;
  // Characters kept of one cell's text.
  maxCellChars: number;
}

export const XLSX_LIMITS: XlsxLimits = {
  maxPartBytes: 32 * MiB,
  maxTotalBytes: 48 * MiB,
  maxRows: 20_050,
  maxColumns: 64,
  maxCellChars: 2000,
};

export interface SheetCell {
  // date: a number cell formatted as a date; value is then the serial day number as stored.
  kind: 'number' | 'text' | 'date' | 'boolean';
  value: string;
}

export interface SheetRow {
  // 1-based row number in the sheet.
  rowNo: number;
  // 0-based column (A = 0) to cell; empty cells are absent.
  cells: Map<number, SheetCell>;
}

export interface Sheet {
  name: string;
  rows: SheetRow[];
  // true when the workbook counts days from 1904 (Excel for Mac before 2011).
  date1904: boolean;
}

const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return bytes.length >= signature.length && signature.every((b, i) => bytes[i] === b);
}

const utf8 = new TextDecoder('utf-8', { fatal: false });

function partText(bytes: Uint8Array, name: string): string {
  const text = utf8.decode(bytes);
  if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) throw new XlsxError(`Tệp Excel có DOCTYPE/ENTITY ở ${name}, bị từ chối`);
  return text;
}

const structure = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
  htmlEntities: false,
  isArray: (name) => ['sheet', 'Relationship', 'Override', 'numFmt', 'xf'].includes(name),
});

type Node = Record<string, unknown>;
const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && !Array.isArray(value);
const nodes = (value: unknown): Node[] => (Array.isArray(value) ? value.filter(isNode) : []);
const attr = (node: Node, key: string): string | null => (typeof node[key] === 'string' ? (node[key] as string) : null);

function parseStructure(bytes: Uint8Array, name: string): Node {
  try {
    const tree: unknown = structure.parse(partText(bytes, name));
    if (isNode(tree)) return tree;
  } catch (error) {
    if (error instanceof XlsxError) throw error;
  }
  throw new XlsxError(`Tệp Excel bị hỏng (không đọc được ${name})`);
}

// The five predefined XML entities and character references. With DOCTYPE refused no other entity can be declared, so
// anything else is left as written.
export function decodeXmlText(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(lt|gt|amp|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});/g, (whole, ref: string) => {
    switch (ref) {
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const code = ref[1] === 'x' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
        return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
      }
    }
  });
}

// "AB12" -> 27 (0-based column), or null when the reference is not a cell reference.
export function columnOf(ref: string): number | null {
  const letters = /^([A-Z]{1,3})\d*$/.exec(ref.toUpperCase())?.[1];
  if (!letters) return null;
  let column = 0;
  for (const ch of letters) column = column * 26 + (ch.charCodeAt(0) - 64);
  return column - 1;
}

function resolveTarget(target: string): string {
  // Targets are relative to xl/ unless absolute within the package.
  const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '..') segments.pop();
    else if (segment !== '.' && segment !== '') segments.push(segment);
  }
  return segments.join('/');
}

// Built-in number formats that show a date or a time (ECMA-376 Part 1, 18.8.30).
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

// A custom format code shows a date when, outside quoted text, escapes and [colour] or [$-locale] blocks, it has a
// day, month or year token.
export function isDateFormat(code: string): boolean {
  const bare = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*\]/g, '');
  return /[dmy]/i.test(bare) && !/^[#0.,%\s]*$/.test(bare);
}

function dateStyles(styles: Uint8Array | undefined): Set<number> {
  const dated = new Set<number>();
  if (!styles) return dated;
  const root = parseStructure(styles, 'styles.xml').styleSheet;
  if (!isNode(root)) return dated;
  const custom = new Map<number, string>();
  if (isNode(root.numFmts)) {
    for (const fmt of nodes(root.numFmts.numFmt)) {
      const id = Number(attr(fmt, 'numFmtId'));
      const code = attr(fmt, 'formatCode');
      if (Number.isInteger(id) && code !== null) custom.set(id, code);
    }
  }
  if (isNode(root.cellXfs)) {
    nodes(root.cellXfs.xf).forEach((xf, index) => {
      const id = Number(attr(xf, 'numFmtId') ?? '0');
      const code = custom.get(id);
      if (code !== undefined ? isDateFormat(code) : BUILTIN_DATE_FORMATS.has(id)) dated.add(index);
    });
  }
  return dated;
}

function textOfRuns(xml: string, limit: number): string {
  // Phonetic runs (rPh) are reading aids, not part of the text.
  const visible = xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '');
  let out = '';
  for (const match of visible.matchAll(/<(?:\w+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g)) {
    out += decodeXmlText(match[1] ?? '');
    if (out.length > limit) return out.slice(0, limit);
  }
  return out;
}

function sharedStrings(bytes: Uint8Array | undefined, limits: XlsxLimits): string[] {
  if (!bytes) return [];
  const xml = partText(bytes, 'sharedStrings.xml');
  const strings: string[] = [];
  const max = limits.maxRows * limits.maxColumns;
  for (const match of xml.matchAll(/<(?:\w+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g)) {
    if (strings.length >= max) throw new XlsxError('Tệp Excel có quá nhiều ô chữ để đọc');
    strings.push(textOfRuns(match[1] ?? '', limits.maxCellChars));
  }
  return strings;
}

const CELL = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
const ROW = /<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g;
const ATTRIBUTE = /([\w:]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function attributes(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of raw.matchAll(ATTRIBUTE)) out.set((m[1] ?? '').replace(/^\w+:/, ''), decodeXmlText(m[2] ?? m[3] ?? ''));
  return out;
}

function innerValue(xml: string): string | null {
  const m = /<(?:\w+:)?v\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?v>)/.exec(xml);
  return m ? decodeXmlText(m[1] ?? '') : null;
}

function readCell(attrs: Map<string, string>, inner: string, strings: string[], dated: Set<number>, limits: XlsxLimits): SheetCell | null {
  const type = attrs.get('t') ?? 'n';
  if (type === 'inlineStr') {
    const is = /<(?:\w+:)?is\b[^>]*>([\s\S]*?)<\/(?:\w+:)?is>/.exec(inner);
    const value = is ? textOfRuns(is[1] ?? '', limits.maxCellChars) : '';
    return value === '' ? null : { kind: 'text', value };
  }
  const raw = innerValue(inner);
  if (raw === null || raw === '') return null;
  switch (type) {
    case 's': {
      const index = Number(raw);
      if (!Number.isInteger(index) || index < 0 || index >= strings.length) throw new XlsxError('Tệp Excel bị hỏng (ô chữ trỏ ra ngoài bảng chữ)');
      const value = strings[index] ?? '';
      return value === '' ? null : { kind: 'text', value };
    }
    case 'str':
    case 'e':
      return { kind: 'text', value: raw.slice(0, limits.maxCellChars) };
    case 'b':
      return { kind: 'boolean', value: raw === '1' ? 'TRUE' : 'FALSE' };
    case 'd':
      // An ISO 8601 date cell (strict OOXML); kept as text for the caller to read.
      return { kind: 'text', value: raw.slice(0, limits.maxCellChars) };
    default: {
      if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(raw)) throw new XlsxError('Tệp Excel bị hỏng (ô số không hợp lệ)');
      const style = Number(attrs.get('s') ?? '0');
      return { kind: dated.has(style) ? 'date' : 'number', value: raw };
    }
  }
}

function readRows(xml: string, strings: string[], dated: Set<number>, limits: XlsxLimits): SheetRow[] {
  const rows: SheetRow[] = [];
  let nextRow = 1;
  for (const rowMatch of xml.matchAll(ROW)) {
    const rowAttrs = attributes(rowMatch[1] ?? '');
    const declared = Number(rowAttrs.get('r'));
    const rowNo = Number.isInteger(declared) && declared >= 1 ? declared : nextRow;
    if (rowNo < nextRow) throw new XlsxError('Tệp Excel bị hỏng (các dòng không theo thứ tự)');
    nextRow = rowNo + 1;
    const cells = new Map<number, SheetCell>();
    let nextColumn = 0;
    for (const cellMatch of (rowMatch[2] ?? '').matchAll(CELL)) {
      const attrs = attributes(cellMatch[1] ?? '');
      const ref = attrs.get('r');
      const column = ref === undefined ? nextColumn : columnOf(ref);
      if (column === null) throw new XlsxError('Tệp Excel bị hỏng (địa chỉ ô không hợp lệ)');
      nextColumn = column + 1;
      if (column >= limits.maxColumns) continue;
      const cell = readCell(attrs, cellMatch[2] ?? '', strings, dated, limits);
      if (cell) cells.set(column, cell);
    }
    if (cells.size === 0) continue;
    if (rows.length >= limits.maxRows) throw new XlsxError(`Tệp Excel có hơn ${limits.maxRows} dòng; hãy chia thành nhiều tệp`);
    rows.push({ rowNo, cells });
  }
  return rows;
}

const WANTED = new Set(['[Content_Types].xml', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/sharedStrings.xml', 'xl/styles.xml']);

// The first sheet of the workbook as rows of cells.
export function readFirstSheet(bytes: Uint8Array, limits: XlsxLimits = XLSX_LIMITS): Sheet {
  if (startsWith(bytes, OLE_SIGNATURE)) {
    throw new XlsxError('Đây là tệp Excel 97-2003 (.xls); hãy mở bằng Excel và lưu lại dạng .xlsx rồi tải lên');
  }
  const zip = { maxEntries: 500, maxTotalBytes: limits.maxTotalBytes, maxEntryBytes: limits.maxPartBytes };
  let parts: Map<string, Uint8Array>;
  try {
    // The workbook's own parts first; the sheet is read once the workbook names it.
    parts = readZipParts(bytes, (name) => WANTED.has(name), zip);
  } catch (error) {
    if (error instanceof ArchiveError) throw new XlsxError(`Không đọc được tệp Excel: ${error.message}`);
    throw error;
  }
  const workbookBytes = parts.get('xl/workbook.xml');
  if (!parts.has('[Content_Types].xml') || !workbookBytes) throw new XlsxError('Không phải tệp Excel .xlsx');
  const workbook = parseStructure(workbookBytes, 'workbook.xml').workbook;
  if (!isNode(workbook)) throw new XlsxError('Tệp Excel bị hỏng (không đọc được workbook.xml)');
  const props = isNode(workbook.workbookPr) ? workbook.workbookPr : {};
  const date1904 = ['1', 'true'].includes(attr(props, 'date1904') ?? '');
  const first = nodes(isNode(workbook.sheets) ? workbook.sheets.sheet : undefined)[0];
  if (!first) throw new XlsxError('Tệp Excel không có trang tính nào');
  const relId = attr(first, 'id');
  const relsBytes = parts.get('xl/_rels/workbook.xml.rels');
  const rels = relsBytes ? parseStructure(relsBytes, 'workbook.xml.rels').Relationships : undefined;
  const target = nodes(isNode(rels) ? rels.Relationship : undefined).find((r) => attr(r, 'Id') === relId);
  const targetPath = target ? attr(target, 'Target') : null;
  if (!targetPath || /^[a-z][a-z0-9+.-]*:/i.test(targetPath)) throw new XlsxError('Tệp Excel bị hỏng (không tìm thấy trang tính đầu tiên)');
  const sheetPath = resolveTarget(targetPath);

  let sheetParts: Map<string, Uint8Array>;
  try {
    const remaining = limits.maxTotalBytes - [...parts.values()].reduce((sum, p) => sum + p.byteLength, 0);
    sheetParts = readZipParts(bytes, (name) => name === sheetPath, { ...zip, maxTotalBytes: Math.max(0, remaining) });
  } catch (error) {
    if (error instanceof ArchiveError) throw new XlsxError(`Không đọc được tệp Excel: ${error.message}`);
    throw error;
  }
  const sheetBytes = sheetParts.get(sheetPath);
  if (!sheetBytes) throw new XlsxError('Tệp Excel bị hỏng (thiếu trang tính đầu tiên)');
  const strings = sharedStrings(parts.get('xl/sharedStrings.xml'), limits);
  const dated = dateStyles(parts.get('xl/styles.xml'));
  const xml = partText(sheetBytes, sheetPath);
  const data = /<(?:\w+:)?sheetData\b[^>]*?(?:\/>|>([\s\S]*)<\/(?:\w+:)?sheetData>)/.exec(xml);
  const name = (attr(first, 'name') ?? '').slice(0, 200);
  return { name, rows: data ? readRows(data[1] ?? '', strings, dated, limits) : [], date1904 };
}

// The calendar day (YYYY-MM-DD) of an Excel serial day number, or null when it is not a plausible date. Excel's 1900
// system counts 1900-02-29, which never existed, so serials from 61 on are one day ahead of the true count.
export function serialToDate(serial: string, date1904: boolean): string | null {
  const value = Number(serial);
  if (!Number.isFinite(value)) return null;
  const day = Math.floor(value);
  if (day < 1 || day > 2_958_465) return null;
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, day >= 61 ? 30 : 31);
  return new Date(epoch + day * 86_400_000).toISOString().slice(0, 10);
}
