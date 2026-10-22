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
// Recurring posts (#979): the rule's next occurrence, for the post page's preview.
export * from './domain/recurrence.ts';
// Banned and sensitive words (#1055): the composer marks matches with the rules the commands apply.
export * from './domain/banned-words.ts';
// Monthly goals (#1056): the report page judges progress with the rules the Metrics tab uses.
export * from './domain/goals.ts';
// White-label client reports (#1053): the settings form checks a logo and an accent with the rules the command applies.
export * from './domain/report-branding.ts';
// The team report (#1058): its rows, the median and the CSV file the Metrics tab saves, with the exports' quoting.
export * from './domain/team-report.ts';
export { csvCell } from './domain/csv.ts';
