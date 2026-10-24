import { bookingCommands } from './bookings.ts';
import { eventTypeCommands, eventTypeQueries } from './event-types.ts';

export * from './event-types.ts';
export * from './bookings.ts';

export const crmCommands = [...eventTypeCommands, ...bookingCommands];
export const crmQueries = [...eventTypeQueries];
