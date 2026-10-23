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
export interface ChannelOptionsInput {
  externalAccountId: string;
  secret: string;
  kind: ChannelOptionKind;
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

// A name as a list keeps it: one line, without invisible marks, at most CHANNEL_OPTION_NAME_MAX characters (code
// points); '' when nothing is left.
export function optionName(raw: string): string {
  const clean = raw.replace(INVISIBLE_ALL, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(clean).slice(0, CHANNEL_OPTION_NAME_MAX).join('').trim();
}
