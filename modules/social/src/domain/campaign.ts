// Campaign labels (#1169): a label may carry its campaign's dates and the UTM campaign and medium its posts' links
// should carry. These are the rules for both, and the two things a reviewer should see on a labelled post: a channel
// whose UTM campaign is not the label's, and a channel planned outside the campaign's dates. Pure, so
// social.post.pre_review and the post page find the same.
import { localTime } from './queue.ts';
import { utmOf, utmTag } from './utm.ts';

// The part of the UTM_TAG rule crove_social.label's CHECKs can say in PostgreSQL (20261029130000): letters (Unicode
// Alphabetic, as the pg_c_utf8 collation reads [[:alpha:]]), ASCII digits, the space separators and the same
// punctuation. A label's tags pass both, so whatever the commands accept the table accepts.
const LABEL_TAG = /^[\p{Alphabetic}0-9\p{Zs}_.,:;!?'()/+&%@#-]{1,100}$/u;

// The tag as a label keeps it (NFC, trimmed), or null when it breaks either rule.
export function labelUtmTag(value: unknown): string | null {
  const tag = utmTag(value);
  return tag !== null && LABEL_TAG.test(tag) ? tag : null;
}

// A real calendar day as YYYY-MM-DD (no 30 February, no year 0, which PostgreSQL lacks).
export function isCalendarDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '0001-01-01' && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
}

export interface Campaign {
  name: string;
  // The first and last day, both included; either may be open.
  startsOn: string | null;
  endsOn: string | null;
  utmCampaign: string | null;
  utmMedium: string | null;
}

// Whether a label says anything about its campaign: one without dates or tags is a plain label, as before #1169.
export const isCampaign = (c: Campaign) => c.startsOn !== null || c.endsOn !== null || c.utmCampaign !== null;

// Whether the day (YYYY-MM-DD) falls outside the campaign's dates; never for a label without dates.
export function outsideCampaign(day: string, c: Pick<Campaign, 'startsOn' | 'endsOn'>): boolean {
  return (c.startsOn !== null && day < c.startsOn) || (c.endsOn !== null && day > c.endsOn);
}

// The UTM fields a post shows once a campaign label is put on it: its empty ones take the label's tags (an off switch
// counts as empty), the ones already typed stay. null when nothing would change, so nothing turns into an edit.
export function prefillUtm(current: { campaign: string; medium: string } | null, c: Pick<Campaign, 'utmCampaign' | 'utmMedium'>): { campaign: string; medium: string } | null {
  if (c.utmCampaign === null) return null;
  const medium = c.utmMedium ?? 'social';
  if (current === null) return { campaign: c.utmCampaign, medium };
  const next = { campaign: current.campaign.trim() ? current.campaign : c.utmCampaign, medium: current.medium.trim() ? current.medium : medium };
  return next.campaign === current.campaign && next.medium === current.medium ? null : next;
}

export interface CampaignChannel {
  // What the finding calls it (the channel's name).
  name: string;
  settings: Readonly<Record<string, unknown>>;
  // The link it sends; without one, UTM tags do nothing.
  linkUrl: string | null;
  // When it goes out (or went out); null while it has no time.
  at: string | null;
}

export type CampaignFinding =
  // The channel's link carries another UTM campaign than the label's, or none (actual null).
  | { kind: 'utm_campaign'; label: string; channel: string; expected: string; actual: string | null }
  // The channel is planned for a day outside the label's dates, in the post's time zone.
  | { kind: 'outside_dates'; label: string; channel: string; day: string; startsOn: string | null; endsOn: string | null };

// What a labelled post's channels get wrong against its campaign labels, label by label then channel by channel.
// Labels without dates or tags find nothing, so a post with plain labels reads as before.
export function campaignFindings(labels: readonly Campaign[], channels: readonly CampaignChannel[], timeZone: string): CampaignFinding[] {
  const out: CampaignFinding[] = [];
  for (const label of labels) {
    for (const ch of channels) {
      if (label.utmCampaign !== null && ch.linkUrl) {
        const actual = utmOf(ch.settings)?.campaign ?? null;
        if (actual !== label.utmCampaign) out.push({ kind: 'utm_campaign', label: label.name, channel: ch.name, expected: label.utmCampaign, actual });
      }
      if ((label.startsOn !== null || label.endsOn !== null) && ch.at !== null) {
        const epoch = Date.parse(ch.at);
        if (Number.isNaN(epoch)) continue;
        const t = localTime(epoch, timeZone);
        const day = `${String(t.year).padStart(4, '0')}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
        if (outsideCampaign(day, label)) out.push({ kind: 'outside_dates', label: label.name, channel: ch.name, day, startsOn: label.startsOn, endsOn: label.endsOn });
      }
    }
  }
  return out;
}
