import { crmAgentQueries } from './agent.ts';
import { bookingFeedCommands, bookingFeedQueries } from './booking-feed.ts';
import { bookingCommands, bookingQueries } from './bookings.ts';
import { eventTypeCommands, eventTypeQueries } from './event-types.ts';

export * from './event-types.ts';
export * from './bookings.ts';
export * from './agent.ts';
export * from './booking-feed.ts';

export const crmCommands = [...eventTypeCommands, ...bookingCommands, ...bookingFeedCommands];
export const crmQueries = [...eventTypeQueries, ...bookingQueries, ...crmAgentQueries, ...bookingFeedQueries];
export { crmManifest } from './manifest.ts';
