// The isomorphic part of the Social module (plan §5.1 `./contract`): channel rules and variant validation, with no
// database, node or server code, so the app checks a post as it is typed with the same rules the commands apply.
export * from './domain/channels.ts';
export * from './domain/validate.ts';
export * from './domain/insights.ts';
export * from './domain/utm.ts';
export * from './domain/occasions.ts';
export * from './domain/mentions.ts';
export * from './domain/media-tags.ts';
// Local clock times in an IANA zone, for moving posts by days in the app (#945) as the queues retime them.
export { localTime, zonedToEpoch, type LocalTime } from './domain/queue.ts';
// The placement `social.queue.set` runs, so a copy of a queue to other channels (#1166) says beforehand how many queued
// posts each one places again.
export { placeQueued, retime, type QueuedPost, type QueueSpec } from './domain/queue.ts';
// Recurring posts (#979): the rule's next occurrence, for the post page's preview.
export * from './domain/recurrence.ts';
export * from './domain/text-variations.ts';
// Banned and sensitive words (#1055): the composer marks matches with the rules the commands apply.
export * from './domain/banned-words.ts';
// Monthly goals (#1056): the report page judges progress with the rules the Metrics tab uses.
export * from './domain/goals.ts';
// Engagement rate (#1157): the Metrics tab, the post page and the client report page work it out as the export does.
export * from './domain/engagement-rate.ts';
// White-label client reports (#1053): the settings form checks a logo and an accent with the rules the command applies.
export * from './domain/report-branding.ts';
// The team report (#1058): its rows, the median and the CSV file the Metrics tab saves, with the exports' quoting.
export * from './domain/team-report.ts';
export { csvCell } from './domain/csv.ts';
// One draft per library file (#1080): the caption a file's name gives, as the command makes it.
export * from './domain/bulk-drafts.ts';
// The same text again on a channel (#1156): the composer compares as the member types, as social.post.get does.
export * from './domain/duplicate.ts';
// Bold and italic text (#1179): the composer styles a selection with the letters the matchers fold back.
export * from './domain/text-styles.ts';
// Campaign labels (#1169): the label's tag rule, the UTM fields a campaign label fills in, and the two findings the post
// page shows as social.post.pre_review does.
export * from './domain/campaign.ts';
// A channel's signature (#1190): the composer, the counter and the previews append it as effectiveContent does.
export * from './domain/signature.ts';
// A long text split into a thread (#1222): the composer splits with the channel's own count and the thread rules.
export * from './domain/thread-split.ts';
// The content plan's CSV file (#978) and the import's cells that hold several values (#1258): the app reads a sheet
// with the rules the export writes it with.
export * from './domain/plan-csv.ts';
