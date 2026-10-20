// The ideas board (#701): the stages its columns show, in order, and how an idea's link is shown.
import type { SOCIAL_IDEA_STAGES } from '@crove/kernel-contract';

export type IdeaStage = (typeof SOCIAL_IDEA_STAGES)[number];
export const BOARD_STAGES: readonly IdeaStage[] = ['new', 'planned', 'drafted'];

// The link's site, without "www.", for the card; the whole link when it does not parse.
export function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
