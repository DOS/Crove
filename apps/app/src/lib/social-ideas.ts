// The ideas board (#701): the stages its columns show, in order, and how an idea's link is shown.
import type { SOCIAL_IDEA_STAGES } from '@crove/kernel-contract';

export type IdeaStage = (typeof SOCIAL_IDEA_STAGES)[number];
export const BOARD_STAGES: readonly IdeaStage[] = ['new', 'planned', 'drafted'];

// AI post ideas (#1181): how many to ask for (the server takes 3 to 10), and the most the theme and occasion take.
export const SUGGEST_COUNTS = [3, 4, 5, 6, 7, 8, 9, 10] as const;
export const SUGGEST_DEFAULT_COUNT = 5;
export const THEME_MAX = 2000;
export const OCCASION_MAX = 200;

// What the AI is told the ideas are for: the chosen label (a campaign, with its dates) and the occasion typed, on one
// line of at most OCCASION_MAX UTF-16 units; undefined when there is neither.
export function ideasOccasion(label: { name: string; startsOn: string | null; endsOn: string | null } | null, occasion: string): string | undefined {
  const dates = label && (label.startsOn || label.endsOn) ? ` (${label.startsOn ? `from ${label.startsOn}` : ''}${label.startsOn && label.endsOn ? ' ' : ''}${label.endsOn ? `to ${label.endsOn}` : ''})` : '';
  const text = [label ? `${label.name}${dates}` : '', occasion]
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('; ');
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > OCCASION_MAX) break;
    out += ch;
  }
  return out.trim() || undefined;
}

// The link's site, without "www.", for the card; the whole link when it does not parse.
export function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
