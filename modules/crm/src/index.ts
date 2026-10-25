import { crmAgentQueries } from './agent.ts';
import { bookingCommands, bookingQueries } from './bookings.ts';
import { eventTypeCommands, eventTypeQueries } from './event-types.ts';

export * from './event-types.ts';
export * from './bookings.ts';
export * from './agent.ts';

export const crmCommands = [...eventTypeCommands, ...bookingCommands];
export const crmQueries = [...eventTypeQueries, ...bookingQueries, ...crmAgentQueries];
