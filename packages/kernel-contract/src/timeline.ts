// A document's timeline (#672): the activity of a proposal, the file it came from and the records its commands acted
// on, oldest first.
import { z } from 'zod';
import { zId } from './schemas.ts';

export const zTimelineEntry = z.object({
  id: zId,
  at: z.string(),
  // What happened, as the activity row names it (file.received, proposal.approved, purchase.recorded ...).
  kind: z.string(),
  recordType: z.string(),
  summary: z.string(),
  actorType: z.enum(['user', 'agent', 'system']),
  // The member's or agent's name while they are in the org; null for a former member or the system.
  actorName: z.string().nullable(),
});
export type TimelineEntry = z.infer<typeof zTimelineEntry>;

export const zTimeline = z.object({ items: z.array(zTimelineEntry), more: z.boolean() });
export type Timeline = z.infer<typeof zTimeline>;
