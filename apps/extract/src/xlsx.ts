// Reader for the first sheet of an .xlsx workbook (the tax portal's invoice list, #465). Runs only inside a parser
// process (see sandbox.ts): the workbook is untrusted. The container is opened with readZipParts, which checks the
// directory, refuses overlapping or escaping entries and caps every inflated part; only the parts a plain table needs
// are inflated (workbook, its relationships, the first sheet, shared strings, styles). DOCTYPE and ENTITY are refused
// in every part, so no entity is ever expanded. The sheet and the shared strings are read by a forward tokenizer
// (nextTag below) and attributes by a forward scanner, without regular expressions: each search starts where the last
// one ended and a missing closing tag refuses the file at once, so the time is one pass over the part, whatever it
// holds, and no tree of the whole sheet is built. The small structural
// parts (workbook, relationships, styles) go through fast-xml-parser and are capped at 4 MB each.
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

const MAX_STRUCTURE_BYTES = 4 * MiB;

function parseStructure(bytes: Uint8Array, name: string): Node {
  if (bytes.byteLength > MAX_STRUCTURE_BYTES) throw new XlsxError(`Tệp Excel có phần ${name} quá lớn để đọc`);
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
  // Real format codes are short; a long one is not read (the replacements below would rescan it).
  if (code.length > 255) return false;
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

// ---------------------------------------------------------------------------------------------------------------
// A forward tokenizer for the sheet and shared-string parts. Every search starts where the previous one ended and an
// element's closing tag is looked for once, from its opening tag on; a missing one refuses the file at once. So a
// hostile part (thousands of unclosed tags) costs one pass, never a rescan per tag.

const CORRUPT = 'Tệp Excel bị hỏng (thẻ XML không đóng)';

interface Tag {
  // The name as written (with any namespace prefix) and without its prefix.
  name: string;
  local: string;
  closing: boolean;
  selfClosing: boolean;
  // The attribute text between the name and the end of the tag.
  attrs: string;
  // Index just past the tag's '>'.
  end: number;
}

// The next tag at or after `from` and before `limit`, skipping comments and processing instructions; null when none.
// A CDATA section met as a tag is refused (Excel and the portal's exporter never write them); inside a <v> or <t> the
// text is taken as written, a "<![CDATA[" included, never interpreted. DOCTYPE never gets this far.
export function nextTag(xml: string, from: number, limit: number): Tag | null {
  let i = xml.indexOf('<', from);
  while (i >= 0 && i < limit) {
    if (xml.startsWith('<!--', i)) {
      const close = xml.indexOf('-->', i + 4);
      if (close < 0 || close + 3 > limit) throw new XlsxError(CORRUPT);
      i = xml.indexOf('<', close + 3);
      continue;
    }
    if (xml.startsWith('<?', i)) {
      const close = xml.indexOf('?>', i + 2);
      if (close < 0 || close + 2 > limit) throw new XlsxError(CORRUPT);
      i = xml.indexOf('<', close + 2);
      continue;
    }
    if (xml.startsWith('<!', i)) throw new XlsxError('Tệp Excel có phần XML không được hỗ trợ (CDATA)');
    let j = i + 1;
    const closing = xml[j] === '/';
    if (closing) j += 1;
    const nameStart = j;
    while (j < limit && !' \t\r\n/>'.includes(xml[j] ?? '>')) j += 1;
    const name = xml.slice(nameStart, j);
    if (name === '') throw new XlsxError(CORRUPT);
    // The end of the tag, past any quoted attribute value (which may hold '>').
    const attrStart = j;
    let quote: string | null = null;
    while (j < limit) {
      const ch = xml[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      j += 1;
    }
    if (j >= limit) throw new XlsxError(CORRUPT);
    const selfClosing = xml[j - 1] === '/';
    const colon = name.indexOf(':');
    return {
      name,
      local: colon >= 0 ? name.slice(colon + 1) : name,
      closing,
      selfClosing,
      attrs: xml.slice(attrStart, selfClosing ? j - 1 : j),
      end: j + 1,
    };
  }
  return null;
}

// Where the element opened by `tag` closes: the index of its closing tag and the index just past it. The elements read
// here (row, c, v, is, t, si, rPh) never nest in themselves, so the first closing tag of the same name is the one.
function closeOf(xml: string, tag: Tag, limit: number): { at: number; end: number } {
  const needle = `</${tag.name}`;
  let at = xml.indexOf(needle, tag.end);
  // "</c" must not be taken from "</cols>": the name ends at '>' or white space.
  while (at >= 0 && at < limit && !/[>\s]/.test(xml[at + needle.length] ?? '')) at = xml.indexOf(needle, at + 1);
  if (at < 0 || at >= limit) throw new XlsxError(CORRUPT);
  const gt = xml.indexOf('>', at);
  if (gt < 0 || gt >= limit) throw new XlsxError(CORRUPT);
  return { at, end: gt + 1 };
}

const SPACE = ' \t\r\n';

// The tag's attributes by local name, read in one forward pass (no regular expression, so no backtracking on a hostile
// name without '='). Something that is not name="value" or name='value' is skipped up to the next white space.
export function attributes(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  const n = raw.length;
  while (i < n) {
    while (i < n && SPACE.includes(raw[i] ?? '')) i += 1;
    const start = i;
    while (i < n && !SPACE.includes(raw[i] ?? '') && raw[i] !== '=') i += 1;
    const name = raw.slice(start, i);
    while (i < n && SPACE.includes(raw[i] ?? '')) i += 1;
    if (raw[i] !== '=') {
      // A name without a value (not XML): skip it.
      if (i === start) i += 1;
      continue;
    }
    i += 1;
    while (i < n && SPACE.includes(raw[i] ?? '')) i += 1;
    const quote = raw[i];
    if (quote !== '"' && quote !== "'") {
      while (i < n && !SPACE.includes(raw[i] ?? '')) i += 1;
      continue;
    }
    const close = raw.indexOf(quote, i + 1);
    if (close < 0) break;
    if (name !== '') {
      const colon = name.lastIndexOf(':');
      out.set(colon >= 0 ? name.slice(colon + 1) : name, decodeXmlText(raw.slice(i + 1, close)));
    }
    i = close + 1;
  }
  return out;
}

// The text of the <t> elements between `from` and `limit` (a shared string or an inline string), leaving out phonetic
// runs (rPh), which are reading aids and not part of the text.
function textOfRuns(xml: string, from: number, limit: number, max: number): string {
  let out = '';
  let p = from;
  for (let tag = nextTag(xml, p, limit); tag; tag = nextTag(xml, p, limit)) {
    p = tag.end;
    if (tag.closing || tag.selfClosing) continue;
    if (tag.local === 'rPh' || tag.local === 't') {
      const close = closeOf(xml, tag, limit);
      if (tag.local === 't' && out.length <= max) out += decodeXmlText(xml.slice(tag.end, close.at));
      p = close.end;
    }
  }
  return out.length > max ? out.slice(0, max) : out;
}

function sharedStrings(bytes: Uint8Array | undefined, limits: XlsxLimits): string[] {
  if (!bytes) return [];
  const xml = partText(bytes, 'sharedStrings.xml');
  const strings: string[] = [];
  const max = limits.maxRows * limits.maxColumns;
  let p = 0;
  for (let tag = nextTag(xml, p, xml.length); tag; tag = nextTag(xml, p, xml.length)) {
    p = tag.end;
    if (tag.local !== 'si' || tag.closing) continue;
    if (strings.length >= max) throw new XlsxError('Tệp Excel có quá nhiều ô chữ để đọc');
    if (tag.selfClosing) {
      strings.push('');
      continue;
    }
    const close = closeOf(xml, tag, xml.length);
    strings.push(textOfRuns(xml, tag.end, close.at, limits.maxCellChars));
    p = close.end;
  }
  return strings;
}

// The content of the first child element `local` of [from, limit), or null when there is none.
function childText(xml: string, from: number, limit: number, local: string): { from: number; to: number } | null {
  let p = from;
  for (let tag = nextTag(xml, p, limit); tag; tag = nextTag(xml, p, limit)) {
    p = tag.end;
    if (tag.closing) continue;
    if (tag.local === local) {
      if (tag.selfClosing) return { from: tag.end, to: tag.end };
      return { from: tag.end, to: closeOf(xml, tag, limit).at };
    }
    if (!tag.selfClosing) p = closeOf(xml, tag, limit).end;
  }
  return null;
}

function readCell(attrs: Map<string, string>, xml: string, from: number, limit: number, strings: string[], dated: Set<number>, limits: XlsxLimits): SheetCell | null {
  const type = attrs.get('t') ?? 'n';
  if (type === 'inlineStr') {
    const is = childText(xml, from, limit, 'is');
    const value = is ? textOfRuns(xml, is.from, is.to, limits.maxCellChars) : '';
    return value === '' ? null : { kind: 'text', value };
  }
  const v = childText(xml, from, limit, 'v');
  const raw = v ? decodeXmlText(xml.slice(v.from, Math.min(v.to, v.from + limits.maxCellChars * 8))) : null;
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

function readRows(xml: string, from: number, limit: number, strings: string[], dated: Set<number>, limits: XlsxLimits): SheetRow[] {
  const rows: SheetRow[] = [];
  let nextRow = 1;
  let p = from;
  for (let tag = nextTag(xml, p, limit); tag; tag = nextTag(xml, p, limit)) {
    p = tag.end;
    if (tag.local !== 'row' || tag.closing) continue;
    const rowAttrs = attributes(tag.attrs);
    const declared = Number(rowAttrs.get('r'));
    const rowNo = Number.isInteger(declared) && declared >= 1 ? declared : nextRow;
    if (rowNo < nextRow) throw new XlsxError('Tệp Excel bị hỏng (các dòng không theo thứ tự)');
    nextRow = rowNo + 1;
    if (tag.selfClosing) continue;
    const rowClose = closeOf(xml, tag, limit);
    p = rowClose.end;
    const cells = new Map<number, SheetCell>();
    let nextColumn = 0;
    let q = tag.end;
    for (let cellTag = nextTag(xml, q, rowClose.at); cellTag; cellTag = nextTag(xml, q, rowClose.at)) {
      q = cellTag.end;
      if (cellTag.local !== 'c' || cellTag.closing) continue;
      const attrs = attributes(cellTag.attrs);
      const ref = attrs.get('r');
      const column = ref === undefined ? nextColumn : columnOf(ref);
      if (column === null) throw new XlsxError('Tệp Excel bị hỏng (địa chỉ ô không hợp lệ)');
      nextColumn = column + 1;
      if (cellTag.selfClosing) continue;
      const cellClose = closeOf(xml, cellTag, rowClose.at);
      q = cellClose.end;
      if (column >= limits.maxColumns) continue;
      const cell = readCell(attrs, xml, cellTag.end, cellClose.at, strings, dated, limits);
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
  const name = (attr(first, 'name') ?? '').slice(0, 200);
  // The rows are inside sheetData; anything before it (dimension, columns) and after it is not read.
  let p = 0;
  for (let tag = nextTag(xml, p, xml.length); tag; tag = nextTag(xml, p, xml.length)) {
    p = tag.end;
    if (tag.local !== 'sheetData' || tag.closing) continue;
    if (tag.selfClosing) break;
    return { name, rows: readRows(xml, tag.end, closeOf(xml, tag, xml.length).at, strings, dated, limits), date1904 };
  }
  return { name, rows: [], date1904 };
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
