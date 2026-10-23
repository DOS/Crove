// What a connected channel offers to pick from in the composer (#1120): a Pinterest board's sections. It only reads.
// The worker asks for one kind of list with the channel's token; the composer shows the names, and the adapter checks
// a chosen id again when it publishes. not_found: the channel itself (the board) is gone; null: no answer worth
// keeping (a network failure, a malformed answer).
export const CHANNEL_OPTION_KINDS = ['pinterest_section'] as const;
export type ChannelOptionKind = (typeof CHANNEL_OPTION_KINDS)[number];
// The most options a list keeps, and the longest name kept of one.
export const CHANNEL_OPTIONS_MAX = 500;
export const CHANNEL_OPTION_NAME_MAX = 200;
export interface ChannelOptionsInput {
  externalAccountId: string;
  secret: string;
  kind: ChannelOptionKind;
}
export interface ChannelOption {
  id: string;
  name: string;
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
