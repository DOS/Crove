// Labels for posts (#639): the classes each label colour shows with, and choosing a post's labels. No browser or
// React imports, so it is unit tested.
import { SOCIAL_LABEL_COLORS } from '@crove/kernel-contract';
import { labelUtmTag } from '@crove/mod-social/contract';

export type LabelColor = (typeof SOCIAL_LABEL_COLORS)[number];
export const LABEL_COLORS: readonly LabelColor[] = SOCIAL_LABEL_COLORS;
// A new label's colour unless one is picked, as on the server.
export const DEFAULT_LABEL_COLOR = 'gray' satisfies LabelColor;
// At most this many labels on one post (social.post.set_labels checks it again).
export const MAX_LABELS_PER_POST = 10;

// A chip in the label's hue, from the theme's label tokens (packages/ui globals.css); gray is the neutral chip.
export const LABEL_TONE: Record<LabelColor, string> = {
  gray: 'border-border bg-muted text-muted-foreground',
  red: 'border-label-red/30 bg-label-red/10 text-label-red',
  orange: 'border-label-orange/30 bg-label-orange/10 text-label-orange',
  yellow: 'border-label-yellow/30 bg-label-yellow/10 text-label-yellow',
  green: 'border-label-green/30 bg-label-green/10 text-label-green',
  teal: 'border-label-teal/30 bg-label-teal/10 text-label-teal',
  blue: 'border-label-blue/30 bg-label-blue/10 text-label-blue',
  purple: 'border-label-purple/30 bg-label-purple/10 text-label-purple',
  pink: 'border-label-pink/30 bg-label-pink/10 text-label-pink',
};

// A swatch of the colour, for the colour picker.
export const LABEL_SWATCH: Record<LabelColor, string> = {
  gray: 'bg-muted-foreground',
  red: 'bg-label-red',
  orange: 'bg-label-orange',
  yellow: 'bg-label-yellow',
  green: 'bg-label-green',
  teal: 'bg-label-teal',
  blue: 'bg-label-blue',
  purple: 'bg-label-purple',
  pink: 'bg-label-pink',
};

export function isLabelColor(value: string): value is LabelColor {
  return (LABEL_COLORS as readonly string[]).includes(value);
}

// The post's labels with one turned on or off; null when turning it on would pass the per-post limit.
export function toggleLabel(current: readonly string[], labelId: string): string[] | null {
  if (current.includes(labelId)) return current.filter((id) => id !== labelId);
  if (current.length >= MAX_LABELS_PER_POST) return null;
  return [...current, labelId];
}

// The labels of a post as the org's label list has them (by name), skipping any deleted since the post was read.
export function labelsOf<L extends { id: string }>(ids: readonly string[], labels: readonly L[]): L[] {
  const wanted = new Set(ids);
  return labels.filter((l) => wanted.has(l.id));
}

// A label's campaign (#1169) as the Labels page form holds it: '' for a field left empty.
export type CampaignDraft = { startsOn: string; endsOn: string; utmCampaign: string; utmMedium: string };

// What is wrong with the campaign as typed, as social.label.create and .update would refuse it; null when it may be
// saved.
export function campaignProblem(d: CampaignDraft): 'dates' | 'utm' | 'mediumNeedsCampaign' | null {
  if (d.startsOn && d.endsOn && d.endsOn < d.startsOn) return 'dates';
  if ((d.utmCampaign.trim() && labelUtmTag(d.utmCampaign) === null) || (d.utmMedium.trim() && labelUtmTag(d.utmMedium) === null)) return 'utm';
  if (d.utmMedium.trim() && !d.utmCampaign.trim()) return 'mediumNeedsCampaign';
  return null;
}

// The campaign's fields for a create or an update: empty ones as null, so an update clears them.
export function campaignInput(d: CampaignDraft): { startsOn: string | null; endsOn: string | null; utmCampaign: string | null; utmMedium: string | null } {
  return { startsOn: d.startsOn || null, endsOn: d.endsOn || null, utmCampaign: d.utmCampaign.trim() || null, utmMedium: d.utmMedium.trim() || null };
}

// The report period a campaign label suggests (#1169): its first and last day where it has them, else the period
// shown, and never a last day before the first.
export function labelPeriod(label: { startsOn: string | null; endsOn: string | null }, shown: { from: string; to: string }): { from: string; to: string } {
  const from = label.startsOn ?? (label.endsOn !== null && shown.from > label.endsOn ? label.endsOn : shown.from);
  const to = label.endsOn ?? (shown.to < from ? from : shown.to);
  return { from, to };
}
