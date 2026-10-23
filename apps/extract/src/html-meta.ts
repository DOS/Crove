// What a web page says about itself, for a link preview (#641): the title, description and site name from its head,
// Open Graph first, then Twitter cards, then <title> and <meta name="description">; and its main text (#779), from the
// <article> with the most text, else the <main> with the most, else the body, without menus, headers, footers, forms or
// embeds. Plain scanning: no DOM, no scripts, no styles, no external resources. The text is decoded from the page's
// charset, entities are resolved, whitespace collapsed and every field capped.
import { EXTRACT_LIMITS, type ExtractedPage } from '@crove/extract-contract';

export class HtmlMetaError extends Error {}

// The charset the page declares near its start (a <meta charset> or http-equiv content type); UTF-8 otherwise.
function charsetOf(bytes: Uint8Array): string {
  const start = Buffer.from(bytes.subarray(0, 2048)).toString('latin1');
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_-]{1,40})/i.exec(start);
  return m?.[1]?.toLowerCase() ?? 'utf-8';
}

function decode(bytes: Uint8Array): string {
  const label = charsetOf(bytes);
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    // An unknown label: read it as UTF-8.
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function entities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith('#x') || lower.startsWith('#')) {
      const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
      // Not a character, a surrogate or a control: dropped.
      if (!Number.isFinite(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || code < 0x20) return ' ';
      return String.fromCodePoint(code);
    }
    return NAMED[lower] ?? whole;
  });
}

// At most max UTF-16 units, as the contract's limits count them, never ending inside a surrogate pair.
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = text.charCodeAt(max - 1);
  return text.slice(0, end >= 0xd800 && end <= 0xdbff ? max - 1 : max);
}

function clean(raw: string | undefined, max: number): string | null {
  if (raw === undefined) return null;
  const text = entities(raw)
    // Control characters (but not whitespace) are dropped.
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return null;
  return cut(text, max).trim() || null;
}

// The attributes of one tag: name="value", name='value' or name=value.
function attributes(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]{0,63})\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (let m = re.exec(tag); m !== null; m = re.exec(tag)) {
    const name = (m[1] as string).toLowerCase();
    if (!out.has(name)) out.set(name, m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

// Comments and the given elements removed with what they hold, in one pass: each opening is matched with its own
// close, and one that never closes ends the text there (nothing after it can be read as a tag).
const HIDDEN = ['script', 'style', 'noscript', 'template'];
function stripHidden(html: string, names: readonly string[] = HIDDEN): string {
  const open = new RegExp(`<!--|<(${names.join('|')})\\b`, 'gi');
  let out = '';
  let from = 0;
  for (let m = open.exec(html); m !== null; m = open.exec(html)) {
    out += html.slice(from, m.index);
    let close: number;
    let closeLength: number;
    if (m[0] === '<!--') {
      close = html.indexOf('-->', open.lastIndex);
      closeLength = 3;
    } else {
      const end = new RegExp(`</${m[1] as string}\\s*>`, 'gi');
      end.lastIndex = open.lastIndex;
      const e = end.exec(html);
      close = e ? e.index : -1;
      closeLength = e ? e[0].length : 0;
    }
    if (close < 0) return `${out} `;
    from = close + closeLength;
    open.lastIndex = from;
    out += ' ';
  }
  return out + html.slice(from);
}

// Each <meta ...> tag of the head; a tag that never closes ends the scan.
function metaTags(head: string): string[] {
  const tags: string[] = [];
  const open = /<meta\b/gi;
  for (let m = open.exec(head); m !== null; m = open.exec(head)) {
    const close = head.indexOf('>', open.lastIndex);
    if (close < 0) break;
    tags.push(head.slice(m.index, close + 1));
    open.lastIndex = close + 1;
  }
  return tags;
}

function titleOf(head: string): string | undefined {
  const open = /<title\b/i.exec(head);
  if (!open) return undefined;
  const start = head.indexOf('>', open.index);
  if (start < 0) return undefined;
  // The title is plain text (RCDATA): a < inside it is part of it; only </title> ends it.
  const close = /<\/title\s*>/gi;
  close.lastIndex = start + 1;
  const end = close.exec(head);
  return end ? head.slice(start + 1, end.index) : undefined;
}

// Page furniture: menus, banners, footers, forms and embeds, dropped with what they hold.
const FURNITURE = ['nav', 'header', 'footer', 'aside', 'form', 'button', 'select', 'svg', 'iframe', 'object', 'canvas'];
// The ends of blocks (and <br>) are new lines; inline tags join their text to the words around it; every other tag
// is a space.
const BLOCKS = new Set(['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'blockquote', 'section', 'pre', 'dd', 'dt', 'figcaption']);
const INLINE = new Set(['a', 'b', 'i', 'u', 's', 'q', 'em', 'strong', 'span', 'small', 'mark', 'code', 'abbr', 'sub', 'sup', 'time']);
const TAG_NAME = /^(\/?)([a-zA-Z][a-zA-Z0-9]{0,15})/;

// The text of html without its tags, in one pass: a < with no > before the next < is a stray character, and no < or >
// is left in the result, so nothing in it can read as markup. Linear: the next > is looked up only once it is behind.
function plainText(html: string): string {
  let out = '';
  let at = 0;
  let gt = html.indexOf('>');
  while (at < html.length) {
    const lt = html.indexOf('<', at);
    if (lt < 0) {
      out += html.slice(at);
      break;
    }
    out += html.slice(at, lt);
    if (gt >= 0 && gt < lt) gt = html.indexOf('>', lt);
    const next = html.indexOf('<', lt + 1);
    if (gt < 0 || (next >= 0 && next < gt)) {
      out += ' ';
      at = lt + 1;
      continue;
    }
    const m = TAG_NAME.exec(html.slice(lt + 1, Math.min(gt, lt + 18)));
    const name = m?.[2]?.toLowerCase() ?? '';
    out += name === 'br' || (m?.[1] === '/' && BLOCKS.has(name)) ? '\n' : INLINE.has(name) ? '' : ' ';
    at = gt + 1;
  }
  return out.replaceAll('>', ' ');
}

// The parts of html inside each outermost <name ...> ... </name>, in order, at most MAX_SCOPES: an element nested in
// another stays part of it, and one that never closes runs to the end. The parts never overlap, so reading all of them
// reads the page once.
const MAX_SCOPES = 50;
function outermost(html: string, name: string): string[] {
  const tag = new RegExp(`<(/?)${name}\\b[^<>]*>`, 'gi');
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let m = tag.exec(html); m !== null && parts.length < MAX_SCOPES; m = tag.exec(html)) {
    if (m[1] === '') {
      if (depth++ === 0) start = m.index + m[0].length;
    } else if (depth > 0 && --depth === 0) parts.push(html.slice(start, m.index));
  }
  if (depth > 0 && parts.length < MAX_SCOPES) parts.push(html.slice(start));
  return parts;
}

// The lines of plain text of one part of the page, without its furniture.
function linesOf(scope: string): string[] {
  return plainText(stripHidden(scope, FURNITURE))
    .split('\n')
    .map((line) => clean(line, EXTRACT_LIMITS.maxPageTextChars))
    .filter((line): line is string => line !== null);
}

// The page's main text: lines of plain text, at most maxPageTextChars; null when there is none. It comes from the
// <article> with the most text (a page often has teaser cards of other articles before or after its own, #1235),
// else the <main> with the most, else the body.
function mainText(html: string): string | null {
  const bodyAt = html.search(/<body\b/i);
  const body = bodyAt >= 0 ? html.slice(bodyAt) : html;
  const articles = outermost(body, 'article');
  const scopes = articles.length > 0 ? articles : outermost(body, 'main');
  let lines: string[] = [];
  let size = -1;
  for (const scope of scopes.length > 0 ? scopes : [body]) {
    const found = linesOf(scope);
    const length = found.reduce((n, line) => n + line.length, 0);
    if (length > size) {
      lines = found;
      size = length;
    }
  }
  if (lines.length === 0) return null;
  return cut(lines.join('\n'), EXTRACT_LIMITS.maxPageTextChars).trim() || null;
}

export function readHtmlMeta(bytes: Uint8Array): ExtractedPage {
  const html = stripHidden(decode(bytes));
  const end = html.search(/<\/head\s*>|<body\b/i);
  const head = end >= 0 ? html.slice(0, end) : html;
  if (!/<(html|head|meta|title)\b/i.test(head)) throw new HtmlMetaError('Trang không phải HTML');
  const meta = new Map<string, string>();
  for (const tag of metaTags(head)) {
    const a = attributes(tag);
    const key = (a.get('property') ?? a.get('name'))?.toLowerCase();
    const content = a.get('content');
    if (key && content !== undefined && !meta.has(key)) meta.set(key, content);
  }
  return {
    title: clean(meta.get('og:title') ?? meta.get('twitter:title') ?? titleOf(head), EXTRACT_LIMITS.maxPageTitleChars),
    description: clean(meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description'), EXTRACT_LIMITS.maxPageDescriptionChars),
    siteName: clean(meta.get('og:site_name') ?? meta.get('application-name'), EXTRACT_LIMITS.maxPageSiteChars),
    text: mainText(html),
  };
}