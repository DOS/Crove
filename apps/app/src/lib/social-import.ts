// Drafts from a sheet (#586): a CSV or Excel file with a row per post, read in the browser so the member sees each
// row's problems before anything is saved. Columns, found by their header in Vietnamese or English: text (required),
// title, link, channels (names of connected channels, or a provider such as "facebook", separated by ";"; "all" for
// every active channel) and time (the planned time, "2026-10-25 09:00" or "25/10/2026 09:00", local).
// Since #1258 also media (library file names or ids, or https image URLs, up to IMPORT_MEDIA_MAX), alt (their alt
// texts), first_comment and labels, read with the content plan export's cell rules (domain/plan-csv.ts in the Social
// module), so an exported plan comes back as it went out. The files and URLs are looked up on the server
// (social.media.resolve, social.media.fetchUrls) and their problems join the row's (withMedia).
import { IMPORT_MEDIA_MAX, altsOf, isMediaUrl, labelNamesOf, mediaRefsOf } from '@crove/mod-social/contract';
import { headerKey } from './bank-statement.ts';
import type { SheetRows } from './xlsx.ts';

export const MAX_IMPORT_ROWS = 200;
export const IMPORT_COLUMNS = ['text', 'title', 'link', 'channels', 'time', 'media', 'alt', 'first_comment', 'labels'] as const;
export type ImportColumn = (typeof IMPORT_COLUMNS)[number];
export { IMPORT_MEDIA_MAX };

const HEADERS: Readonly<Record<ImportColumn, readonly string[]>> = {
  text: ['text', 'noi dung', 'body', 'caption', 'bai viet'],
  title: ['title', 'tieu de'],
  link: ['link', 'lien ket', 'url', 'duong dan'],
  channels: ['channels', 'channel', 'kenh', 'cac kenh'],
  time: ['time', 'gio', 'thoi gian', 'gio dang', 'planned', 'ngay gio'],
  media: ['media', 'image', 'images', 'photo', 'photos', 'anh', 'hinh', 'hinh anh', 'media urls', 'image url', 'tep'],
  alt: ['alt', 'alt text', 'alt texts', 'mo ta anh', 'van ban thay the'],
  first_comment: ['first comment', 'first_comment', 'comment', 'binh luan dau', 'binh luan dau tien'],
  labels: ['labels', 'label', 'tags', 'tag', 'nhan', 'cac nhan'],
};

export interface ImportChannel {
  id: string;
  displayName: string;
  provider: string;
  status: string;
}

export type ImportProblem =
  | 'NO_TEXT'
  | 'TEXT_TOO_LONG'
  | 'TITLE_TOO_LONG'
  | 'NO_CHANNEL'
  | 'UNKNOWN_CHANNEL'
  | 'AMBIGUOUS_CHANNEL'
  | 'BAD_TIME'
  | 'PAST_TIME'
  | 'BAD_LINK'
  // The media cell (#1258), before any lookup: too many files, a URL that is not https, alt texts.
  | 'TOO_MANY_MEDIA'
  | 'MEDIA_BAD_URL'
  | 'TOO_MANY_ALT'
  | 'ALT_TOO_LONG'
  | 'COMMENT_TOO_LONG'
  | 'TOO_MANY_LABELS'
  | 'LABEL_TOO_LONG'
  | 'LABEL_LIMIT'
  // What the server said of a file name or a URL (social.media.resolve, social.media.fetchUrls).
  | MediaLookupProblem;

export type MediaLookupProblem =
  | 'UNKNOWN_FILE'
  | 'AMBIGUOUS_FILE'
  | 'FILE_NOT_ALLOWED'
  | 'MEDIA_URL_INVALID'
  | 'MEDIA_URL_BLOCKED'
  | 'MEDIA_URL_TOO_LARGE'
  | 'MEDIA_URL_NOT_IMAGE'
  | 'MEDIA_URL_UNREACHABLE'
  | 'MEDIA_URL_DOCUMENT'
  | 'MEDIA_URL_BUSY';

// What the server takes for a post (social.post.create): a row past these would refuse the whole import.
const MAX_BODY = 100_000;
const MAX_TITLE = 500;
const MAX_LINK = 2000;
const MAX_ALT = 1000;
const MAX_COMMENT = 10_000;
export const MAX_LABELS_PER_POST = 10;
const MAX_LABEL = 50;
// The org's labels at most (social.label.create), so new names past it are said on their rows.
export const LABEL_LIMIT = 100;

// An https URL the API may fetch: absolute, with a host and no user name or password, at most 2000 characters.
export function fetchableUrl(ref: string): boolean {
  if (ref.length > MAX_LINK) return false;
  try {
    const url = new URL(ref);
    return url.protocol === 'https:' && url.hostname !== '' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validLink(link: string): boolean {
  if (link.length > MAX_LINK || !/^https?:\/\/\S+$/i.test(link)) return false;
  try {
    const url = new URL(link);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// A media reference of a row: a library file by name or id, or an image URL the API fetches.
export interface ImportMediaRef {
  kind: 'file' | 'url';
  ref: string;
  altText: string | null;
}

export interface ImportRow {
  // The row number in the sheet, from 1.
  row: number;
  body: string;
  title: string;
  link: string;
  connectionIds: string[];
  // ISO, or null without a planned time.
  plannedAt: string | null;
  media: ImportMediaRef[];
  labels: string[];
  firstComment: string;
  problems: { code: ImportProblem; value?: string }[];
}

// Provider names a sheet may use for a channel, folded like headers.
const PROVIDER_WORDS: Readonly<Record<string, string>> = {
  facebook: 'facebook_page',
  fb: 'facebook_page',
  'facebook page': 'facebook_page',
  instagram: 'instagram',
  ig: 'instagram',
  zalo: 'zalo_oa',
  'zalo oa': 'zalo_oa',
  threads: 'threads',
  linkedin: 'linkedin',
  'linkedin page': 'linkedin_page',
  youtube: 'youtube',
  tiktok: 'tiktok',
  x: 'x',
  twitter: 'x',
  bluesky: 'bluesky',
  telegram: 'telegram',
  tele: 'telegram',
  mastodon: 'mastodon',
  fediverse: 'mastodon',
  pinterest: 'pinterest',
  discord: 'discord',
  wordpress: 'wordpress',
  wp: 'wordpress',
};

function columnsOf(rows: SheetRows): { header: number; at: Partial<Record<ImportColumn, number>> } | null {
  for (const [rowNo, cells] of [...rows.entries()].slice(0, 10)) {
    const at: Partial<Record<ImportColumn, number>> = {};
    for (const [col, cell] of cells) {
      const key = headerKey(cell.value);
      const found = IMPORT_COLUMNS.find((c) => HEADERS[c].includes(key));
      if (found && at[found] === undefined) at[found] = col;
    }
    if (at.text !== undefined) return { header: rowNo, at };
  }
  return null;
}

// A local time from the sheet: "2026-10-25 09:00", "2026-10-25T09:00", "25/10/2026 09:00" or a date alone (09:00).
export function parseLocalTime(text: string): Date | null {
  const s = text.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(s);
  let y: number;
  let mo: number;
  let d: number;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else {
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(s);
    if (!m) return null;
    [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  const h = m[4] === undefined ? 9 : Number(m[4]);
  const min = m[5] === undefined ? 0 : Number(m[5]);
  const at = new Date(y, mo - 1, d, h, min);
  if (at.getFullYear() !== y || at.getMonth() !== mo - 1 || at.getDate() !== d || h > 23 || min > 59) return null;
  return at;
}

function channelsOf(text: string, channels: readonly ImportChannel[], problems: ImportRow['problems']): string[] {
  const live = channels.filter((c) => c.status === 'active');
  const names = text
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 1 && ['all', 'tat ca'].includes(headerKey(names[0] as string))) return live.map((c) => c.id);
  const ids: string[] = [];
  for (const name of names) {
    const key = headerKey(name);
    const byName = live.filter((c) => headerKey(c.displayName) === key);
    const provider = PROVIDER_WORDS[key];
    const byProvider = provider ? live.filter((c) => c.provider === provider) : [];
    const found = byName.length > 0 ? byName : byProvider;
    if (found.length === 1) {
      if (!ids.includes((found[0] as ImportChannel).id)) ids.push((found[0] as ImportChannel).id);
    } else problems.push({ code: found.length === 0 ? 'UNKNOWN_CHANNEL' : 'AMBIGUOUS_CHANNEL', value: name });
  }
  return ids;
}

// A cell as Crove's CSV exports wrote it (#978): the quote they put before a leading =, +, -, @, tab or carriage return,
// so a spreadsheet keeps it as text, is dropped, and a plan exported and edited comes back with the text it had.
export const unguard = (value: string) => (/^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value);

// The sheet's rows as posts to create, each with its problems; null when no header names a text column.
export function importRows(rows: SheetRows, channels: readonly ImportChannel[], now = Date.now()): ImportRow[] | null {
  const found = columnsOf(rows);
  if (!found) return null;
  const out: ImportRow[] = [];
  for (const [rowNo, cells] of rows) {
    if (rowNo <= found.header) continue;
    const get = (c: ImportColumn) => {
      const col = found.at[c];
      return col === undefined ? '' : unguard((cells.get(col)?.value ?? '').trim());
    };
    const body = get('text');
    const [title, link, channelText, timeText] = [get('title'), get('link'), get('channels'), get('time')];
    const [mediaText, altText, firstComment, labelText] = [get('media'), get('alt'), get('first_comment'), get('labels')];
    if (!body && !title && !link && !channelText && !timeText && !mediaText && !firstComment && !labelText) continue;
    const problems: ImportRow['problems'] = [];
    if (!body) problems.push({ code: 'NO_TEXT' });
    if (body.length > MAX_BODY) problems.push({ code: 'TEXT_TOO_LONG' });
    if (title.length > MAX_TITLE) problems.push({ code: 'TITLE_TOO_LONG' });
    const connectionIds = channelText ? channelsOf(channelText, channels, problems) : [];
    if (connectionIds.length === 0 && !problems.some((p) => p.code === 'UNKNOWN_CHANNEL' || p.code === 'AMBIGUOUS_CHANNEL')) problems.push({ code: 'NO_CHANNEL' });
    let plannedAt: string | null = null;
    if (timeText) {
      const at = parseLocalTime(timeText);
      if (!at) problems.push({ code: 'BAD_TIME', value: timeText });
      else if (at.getTime() <= now) problems.push({ code: 'PAST_TIME', value: timeText });
      else plannedAt = at.toISOString();
    }
    if (link && !validLink(link)) problems.push({ code: 'BAD_LINK', value: link.slice(0, 80) });
    const media = mediaOf(mediaText, altText, problems);
    if (firstComment.length > MAX_COMMENT) problems.push({ code: 'COMMENT_TOO_LONG' });
    const labels = labelNamesOf(labelText);
    if (labels.length > MAX_LABELS_PER_POST) problems.push({ code: 'TOO_MANY_LABELS' });
    for (const name of labels) if (name.length > MAX_LABEL) problems.push({ code: 'LABEL_TOO_LONG', value: name.slice(0, 60) });
    out.push({ row: rowNo, body, title, link, connectionIds, plannedAt, media, labels, firstComment, problems });
    if (out.length > MAX_IMPORT_ROWS) break;
  }
  return out;
}

// A row's media cell with its alt texts, in order, each a file reference or a URL.
function mediaOf(mediaText: string, altText: string, problems: ImportRow['problems']): ImportMediaRef[] {
  const refs = [...new Set(mediaRefsOf(mediaText))];
  if (refs.length > IMPORT_MEDIA_MAX) problems.push({ code: 'TOO_MANY_MEDIA', value: String(refs.length) });
  const alts = altsOf(altText, refs.length);
  if (alts.length > refs.length && alts.slice(refs.length).some((a) => a !== null)) problems.push({ code: 'TOO_MANY_ALT' });
  return refs.map((ref, i) => {
    const alt = alts[i] ?? null;
    if (alt !== null && alt.length > MAX_ALT) problems.push({ code: 'ALT_TOO_LONG', value: ref.slice(0, 60) });
    if (isMediaUrl(ref) && !fetchableUrl(ref)) problems.push({ code: 'MEDIA_BAD_URL', value: ref.slice(0, 80) });
    return { kind: isMediaUrl(ref) ? 'url' : 'file', ref, altText: alt };
  });
}

// What the server answered for a reference: the file, or why there is none. Absent: not answered yet.
export interface MediaLookup {
  file: { fileId: string; filename: string; mime: string; sizeBytes: number; durationMs: number | null; width: number | null; height: number | null } | null;
  problem: MediaLookupProblem | null;
}
export const lookupKey = (m: Pick<ImportMediaRef, 'kind' | 'ref'>) => `${m.kind}:${m.ref}`;

// The references still to ask the server for: the files and the fetchable URLs no lookup answers yet.
export function pendingRefs(rows: readonly ImportRow[], lookups: ReadonlyMap<string, MediaLookup>): { files: string[]; urls: string[] } {
  const files = new Set<string>();
  const urls = new Set<string>();
  for (const r of rows) {
    for (const m of r.media) {
      if (lookups.has(lookupKey(m))) continue;
      if (m.kind === 'file') files.add(m.ref);
      else if (fetchableUrl(m.ref)) urls.add(m.ref);
    }
  }
  return { files: [...files], urls: [...urls] };
}

// A row with its files as the server found them: each file with its alt text, the lookups' problems added, and
// whether a lookup is still on its way. A file twice in a row (a URL and its name) is attached once.
export function withMedia(row: ImportRow, lookups: ReadonlyMap<string, MediaLookup>): { files: (NonNullable<MediaLookup['file']> & { altText: string | null })[]; problems: ImportRow['problems']; pending: boolean } {
  const problems = [...row.problems];
  const files: (NonNullable<MediaLookup['file']> & { altText: string | null })[] = [];
  let pending = false;
  for (const m of row.media) {
    if (m.kind === 'url' && !fetchableUrl(m.ref)) continue;
    const found = lookups.get(lookupKey(m));
    if (!found) pending = true;
    else if (found.problem) problems.push({ code: found.problem, value: m.ref.slice(0, 80) });
    else if (found.file && !files.some((f) => f.fileId === found.file?.fileId)) files.push({ ...found.file, altText: m.altText });
  }
  return { files, problems, pending };
}

// The labels the import would create (named by a row that is otherwise ready, and not among the org's), and the rows
// that need one past the org's limit.
export function newLabels(rows: readonly ImportRow[], existing: readonly string[]): { names: string[]; overLimit: Set<number> } {
  const have = new Set(existing.map((n) => n.normalize('NFC').toLowerCase()));
  const names: string[] = [];
  const overLimit = new Set<number>();
  for (const r of rows) {
    for (const name of r.labels) {
      const key = name.toLowerCase();
      if (have.has(key)) continue;
      if (existing.length + names.length >= LABEL_LIMIT) {
        overLimit.add(r.row);
        continue;
      }
      have.add(key);
      names.push(name);
    }
  }
  return { names, overLimit };
}

// The template a member fills in.
export const IMPORT_TEMPLATE = `﻿text,title,link,channels,time,media,alt,first_comment,labels\r\n"Khai trương chi nhánh Quận 3, giảm 20% tuần đầu",,https://example.com,facebook;zalo,2026-11-01 09:00,"https://example.com/khai-truong.jpg\nquay-moi.jpg","Mặt tiền chi nhánh mới\nQuầy pha chế",#khaitruong #quan3,"Khai trương, Quận 3"\r\n`;