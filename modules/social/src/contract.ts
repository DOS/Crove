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
