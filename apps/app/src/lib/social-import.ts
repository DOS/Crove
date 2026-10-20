// Drafts from a sheet (#586): a CSV or Excel file with a row per post, read in the browser so the member sees each
// row's problems before anything is saved. Columns, found by their header in Vietnamese or English: text (required),
// title, link, channels (names of connected channels, or a provider such as "facebook", separated by ";"; "all" for
// every active channel) and time (the planned time, "2026-10-25 09:00" or "25/10/2026 09:00", local).
import { headerKey } from './bank-statement.ts';
import type { SheetRows } from './xlsx.ts';

export const MAX_IMPORT_ROWS = 200;
export const IMPORT_COLUMNS = ['text', 'title', 'link', 'channels', 'time'] as const;
export type ImportColumn = (typeof IMPORT_COLUMNS)[number];

const HEADERS: Readonly<Record<ImportColumn, readonly string[]>> = {
  text: ['text', 'noi dung', 'body', 'caption', 'bai viet'],
  title: ['title', 'tieu de'],
  link: ['link', 'lien ket', 'url', 'duong dan'],
  channels: ['channels', 'channel', 'kenh', 'cac kenh'],
  time: ['time', 'gio', 'thoi gian', 'gio dang', 'planned', 'ngay gio'],
};

export interface ImportChannel {
  id: string;
  displayName: string;
  provider: string;
  status: string;
}

export type ImportProblem = 'NO_TEXT' | 'TEXT_TOO_LONG' | 'TITLE_TOO_LONG' | 'NO_CHANNEL' | 'UNKNOWN_CHANNEL' | 'AMBIGUOUS_CHANNEL' | 'BAD_TIME' | 'PAST_TIME' | 'BAD_LINK';

// What the server takes for a post (social.post.create): a row past these would refuse the whole import.
const MAX_BODY = 100_000;
const MAX_TITLE = 500;
const MAX_LINK = 2000;

function validLink(link: string): boolean {
  if (link.length > MAX_LINK || !/^https?:\/\/\S+$/i.test(link)) return false;
  try {
    const url = new URL(link);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
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
  youtube: 'youtube',
  tiktok: 'tiktok',
  x: 'x',
  twitter: 'x',
  bluesky: 'bluesky',
  telegram: 'telegram',
  tele: 'telegram',
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

// The sheet's rows as posts to create, each with its problems; null when no header names a text column.
export function importRows(rows: SheetRows, channels: readonly ImportChannel[], now = Date.now()): ImportRow[] | null {
  const found = columnsOf(rows);
  if (!found) return null;
  const out: ImportRow[] = [];
  for (const [rowNo, cells] of rows) {
    if (rowNo <= found.header) continue;
    const get = (c: ImportColumn) => {
      const col = found.at[c];
      return col === undefined ? '' : (cells.get(col)?.value ?? '').trim();
    };
    const body = get('text');
    const [title, link, channelText, timeText] = [get('title'), get('link'), get('channels'), get('time')];
    if (!body && !title && !link && !channelText && !timeText) continue;
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
    out.push({ row: rowNo, body, title, link, connectionIds, plannedAt, problems });
    if (out.length > MAX_IMPORT_ROWS) break;
  }
  return out;
}

// The template a member fills in.
export const IMPORT_TEMPLATE = `﻿text,title,link,channels,time\r\n"Khai trương chi nhánh Quận 3, giảm 20% tuần đầu",,https://example.com,facebook;zalo,2026-11-01 09:00\r\n`;