// What a connected channel offers to pick from in the composer (#1120): a Pinterest board's sections, and since #1131 a
// YouTube channel's playlists and a WordPress site's categories and tags. It only reads. The worker asks for one kind
// of list with the channel's token; the composer shows the names, and the adapter checks a chosen option again when it
// publishes. not_found: the channel itself (the board, the YouTube channel, the site's REST API) is gone; null: no
// answer worth keeping (a network failure, a malformed answer, a spent quota).
export const CHANNEL_OPTION_KINDS = ['pinterest_section', 'youtube_playlist', 'wordpress_term'] as const;
export type ChannelOptionKind = (typeof CHANNEL_OPTION_KINDS)[number];
// The most options a list keeps, and the longest name kept of one.
export const CHANNEL_OPTIONS_MAX = 500;
export const CHANNEL_OPTION_NAME_MAX = 200;
// The most bytes a list's items take as PostgreSQL prints them (the CHECK on crove_social.channel_option.items). 500
// names of 200 Vietnamese letters would not fit, so a list stops before it would pass this, as it does at 500 items.
export const CHANNEL_OPTIONS_BYTES_MAX = 131_072;
// How long the worker waits for a whole list (#1131), every page included, and the longest wait for one page. The
// worker's queue serves every org, so a slow platform or site answers no list instead of holding it.
export const CHANNEL_OPTIONS_DEADLINE_MS = 30_000;
export const CHANNEL_OPTIONS_CALL_TIMEOUT_MS = 15_000;
export interface ChannelOptionsInput {
  externalAccountId: string;
  secret: string;
  kind: ChannelOptionKind;
  // Aborted at the worker's deadline: the adapter makes no further call once it is.
  signal?: AbortSignal | undefined;
}
// A WordPress term's taxonomy (#1131): the one list of a site holds both, so each item says which it is.
export const WORDPRESS_TAXONOMIES = ['category', 'tag'] as const;
export type WordPressTaxonomy = (typeof WORDPRESS_TAXONOMIES)[number];
export interface ChannelOption {
  id: string;
  name: string;
  // wordpress_term only, on every item; no other kind has it.
  taxonomy?: WordPressTaxonomy | undefined;
}
export type ChannelOptionsResult = { options: ChannelOption[] } | { refused: 'token_expired' | 'permission' | 'not_found' } | null;

// Control characters, the soft hyphen, zero-width and direction marks and the byte order mark: what an option's name
// never keeps, so a name another app wrote cannot hide or reorder the text around it.
// oxlint-disable-next-line no-control-regex
export const OPTION_NAME_INVISIBLE = /[\u0000-\u001F\u007F-\u009F­؜​-‏‪-‮⁠-⁤⁦-⁩﻿]/;
const INVISIBLE_ALL = new RegExp(OPTION_NAME_INVISIBLE.source, 'g');

// One page's signal: its own CHANNEL_OPTIONS_CALL_TIMEOUT_MS, joined with the worker's deadline when there is one.
export function optionCallSignal(deadline: AbortSignal | undefined): AbortSignal {
  const own = AbortSignal.timeout(CHANNEL_OPTIONS_CALL_TIMEOUT_MS);
  return deadline ? AbortSignal.any([own, deadline]) : own;
}

// An upper bound of the bytes one option adds to a list as PostgreSQL prints jsonb ({"id": "1", "name": "x"}, items
// joined by ", "): its JSON in UTF-8, a space after each colon and comma, and the separator.
export function optionBytes(o: ChannelOption): number {
  return Buffer.byteLength(JSON.stringify(o), 'utf8') + 2 * Object.keys(o).length + 2;
}
// The brackets of an empty list.
export const OPTION_LIST_BYTES_EMPTY = 2;

// A list cut to what it may keep: at most CHANNEL_OPTIONS_MAX items and CHANNEL_OPTIONS_BYTES_MAX bytes, in order.
export function capOptions<T extends ChannelOption>(options: readonly T[]): T[] {
  const kept: T[] = [];
  let bytes = OPTION_LIST_BYTES_EMPTY;
  for (const o of options) {
    const size = optionBytes(o);
    if (kept.length >= CHANNEL_OPTIONS_MAX || bytes + size > CHANNEL_OPTIONS_BYTES_MAX) break;
    kept.push(o);
    bytes += size;
  }
  return kept;
}

// Gathers a list as an adapter reads it, page by page: add() says false once the list is full (500 items, or the next
// one would pass the byte cap), and the list is then kept as it is, cut short like at 500.
export class OptionList {
  readonly options: ChannelOption[] = [];
  private bytes = OPTION_LIST_BYTES_EMPTY;
  private full = false;

  add(o: ChannelOption): boolean {
    if (this.full) return false;
    const size = optionBytes(o);
    if (this.options.length >= CHANNEL_OPTIONS_MAX || this.bytes + size > CHANNEL_OPTIONS_BYTES_MAX) {
      this.full = true;
      return false;
    }
    this.options.push(o);
    this.bytes += size;
    if (this.options.length >= CHANNEL_OPTIONS_MAX) this.full = true;
    return true;
  }

  get isFull(): boolean {
    return this.full;
  }
}

// A name as a list keeps it: one line, without invisible marks, at most CHANNEL_OPTION_NAME_MAX characters (code
// points); '' when nothing is left.
export function optionName(raw: string): string {
  const clean = raw.replace(INVISIBLE_ALL, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(clean).slice(0, CHANNEL_OPTION_NAME_MAX).join('').trim();
}
