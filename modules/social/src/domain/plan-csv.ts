// The content plan's CSV file (#978) and the cells it shares with the CSV import (#586, #1258), isomorphic so the
// export and the app's import read and write the same cells.
//
// The file starts with the import's columns, in its names and formats: text, title, link, channels (the channel's
// name), time ("YYYY-MM-DD HH:mm", local to the time zone asked for, which the app sends as the browser's, the zone the
// import reads times in), then media, alt, first_comment and labels (#1258). Then the plan's own columns: status,
// assignee and post_id. Cells go through csvCell, so a cell a spreadsheet would run as a formula is written as text.
//
// Several values in one cell:
// - media: library file names, file ids or https image URLs, one per line or separated by ";" (a list of URLs separated
//   by commas or spaces, as Publer's sheets have, is split before each "https://" too, so a comma inside a URL stays).
//   The export writes one per line: a file's name when it names that file alone in the org's library and holds no ";"
//   nor line break, else its id.
// - alt: the alt text of each image, one line each in the media's order (an empty line for none); with one image the
//   whole cell is its alt text.
// - labels: label names separated by commas, semicolons or lines (the export writes ", ").
import { csvCell } from './csv.ts';
import { localTime } from './queue.ts';

// The import's columns first, in its names (apps/app/src/lib/social-import.ts IMPORT_COLUMNS).
export const PLAN_CSV_COLUMNS = ['text', 'title', 'link', 'channels', 'time', 'media', 'alt', 'first_comment', 'labels', 'status', 'assignee', 'post_id'] as const;

// Images a row of the import takes, as Publer's CSV does (up to 10 media URLs a post).
export const IMPORT_MEDIA_MAX = 10;

export interface PlanMedia {
  // The file's name, or its id when the name is not one the import could find it by.
  ref: string;
  altText: string | null;
}

export interface PlanRow {
  postId: string;
  variantId: string;
  connectionId: string;
  channel: string;
  provider: string;
  status: string;
  // When it goes out (its slot, its schedule or the post's planned time) or went out, as an ISO instant.
  at: string;
  title: string | null;
  body: string;
  linkUrl: string | null;
  // The images or video the channel shows, in order (#1258).
  media: PlanMedia[];
  // The channel's first comment (#587), or null.
  firstComment: string | null;
  labels: string[];
  // The assignee's name while a member (#640), else null.
  assignee: string | null;
}

const pad = (n: number) => String(n).padStart(2, '0');

// An instant as the import reads a time: "YYYY-MM-DD HH:mm" in the zone.
export function planTime(iso: string, timeZone: string): string {
  const l = localTime(Date.parse(iso), timeZone);
  return `${l.year}-${pad(l.month)}-${pad(l.day)} ${pad(l.hour)}:${pad(l.minute)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isFileId = (ref: string) => UUID.test(ref);
// A reference that is a web address: the import fetches it (https only; anything else is refused on its row).
export const isMediaUrl = (ref: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(ref);

// Whether the export may write a file's name for the import to find it by: one that the cell keeps whole and the
// import does not read as an id or an address. Whether it names one file only is the export's to check.
export const plainMediaName = (name: string) => name.trim() === name && name !== '' && !/[;\r\n]/.test(name) && !isFileId(name) && !isMediaUrl(name);

const isSeparator = (ch: string | undefined) => ch === ',' || (ch !== undefined && ch.trim() === '');

// A part of a media cell split before each http:// or https:// that follows a comma or white space, with the
// separators before it dropped. A linear scan, not a regular expression: a cell is the sheet's, and a pattern with a
// repeated separator before a lookahead backtracks on a long run of spaces or tabs (CodeQL js/polynomial-redos).
function splitUrls(part: string): string[] {
  const lower = part.toLowerCase();
  const out: string[] = [];
  let start = 0;
  for (let at = lower.indexOf('http', 1); at !== -1; at = lower.indexOf('http', at + 1)) {
    const url = lower.startsWith('https://', at) || lower.startsWith('http://', at);
    if (!url || !isSeparator(part[at - 1])) continue;
    let end = at;
    while (end > start && isSeparator(part[end - 1])) end--;
    out.push(part.slice(start, end));
    start = at;
  }
  out.push(part.slice(start));
  return out;
}

// The lines of a text joined by one space each, blank ones left out.
const oneLine = (text: string) =>
  text
    .split(/\r\n|\r|\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ');

// The references of a media cell, in order, empty ones left out.
export function mediaRefsOf(cell: string): string[] {
  return cell
    .split(/[;\r\n]/)
    .flatMap(splitUrls)
    .map((s) => s.trim())
    .filter(Boolean);
}

// The alt text of each of count images, in order: null where there is none. Lines past count are returned too, so the
// import can say there are more alt texts than images.
export function altsOf(cell: string, count: number): (string | null)[] {
  const text = cell.trim();
  if (text === '') return [];
  if (count <= 1) return [oneLine(text)];
  const lines = text.split(/\r?\n/).map((s) => s.trim());
  return lines.map((s) => (s === '' ? null : s));
}

// Label names of a cell, once each whatever the case, in order.
export function labelNamesOf(cell: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of cell.split(/[,;\r\n]/)) {
    const name = raw.trim().normalize('NFC');
    if (name === '' || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

// The cells the export writes for a channel's media and their alt texts (a line break inside an alt text becomes a
// space, so each stays on its line).
export const mediaCell = (media: readonly PlanMedia[]) => media.map((m) => m.ref).join('\n');
export function altCell(media: readonly PlanMedia[]): string {
  const alts = media.map((m) => oneLine(m.altText ?? ''));
  while (alts.length > 0 && alts.at(-1) === '') alts.pop();
  return alts.join('\n');
}

// The rows as a CSV file: a byte order mark (so a spreadsheet opens Vietnamese text as UTF-8), the header, a line each.
export function planCsv(rows: readonly PlanRow[], timeZone: string): string {
  const lines = rows.map((r) =>
    // Label names joined by commas, not semicolons: the import guesses the separator from the first lines, and
    // semicolons there could tip it.
    [r.body, r.title, r.linkUrl, r.channel, planTime(r.at, timeZone), mediaCell(r.media), altCell(r.media), r.firstComment, r.labels.join(', '), r.status, r.assignee, r.postId].map(csvCell).join(','),
  );
  return `﻿${[PLAN_CSV_COLUMNS.join(','), ...lines].join('\r\n')}\r\n`;
}
