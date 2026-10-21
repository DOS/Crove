// The org's audit log as owners and admins read it (#672): every command's audit row, filtered and paged, and the same
// filtered list as a CSV file.
import { z } from 'zod';
import { zId, zLocalDate } from './schemas.ts';

// The most rows one page of kernel.audit.list holds, and the most one CSV export holds.
export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_EXPORT_LIMIT = 10_000;

export const AUDIT_OUTCOMES = ['ok', 'pending_approval', 'denied', 'failed'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

// A command name, or the start of one ending in a dot ("finance." for every finance command).
export const zAuditCommand = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*\.?$/).max(120);

// Who did it: a member or an agent by id, or the system (workers, jobs).
export const zAuditActor = z.union([zId, z.literal('system')]);

export const zAuditFilter = z.object({
  actor: zAuditActor.optional(),
  command: zAuditCommand.optional(),
  outcome: z.enum(AUDIT_OUTCOMES).optional(),
  // The object the command acted on: its id, and optionally its type (e.g. kernel.proposal).
  targetType: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/).max(120).optional(),
  targetId: zId.optional(),
  // Days in Vietnam's time, both included.
  from: zLocalDate.optional(),
  to: zLocalDate.optional(),
});
export type AuditFilter = z.infer<typeof zAuditFilter>;

// Where a page starts: after this row, in the list's order (newest first).
export const zAuditCursor = z.object({ at: z.iso.datetime({ offset: true }), id: zId });
export type AuditCursor = z.infer<typeof zAuditCursor>;

export const zAuditEntry = z.object({
  id: zId,
  at: z.string(),
  actorType: z.enum(['user', 'agent', 'system']),
  actorId: zId.nullable(),
  // The member's or agent's name while they are in the org; null for a former member or the system.
  actorName: z.string().nullable(),
  command: z.string(),
  outcome: z.enum(AUDIT_OUTCOMES),
  targetType: z.string().nullable(),
  targetId: zId.nullable(),
  proposalId: zId.nullable(),
  // The row's detail as one line of key=value pairs, with anything that looks like a secret left out.
  detail: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof zAuditEntry>;

export const zAuditPage = z.object({ items: z.array(zAuditEntry), more: z.boolean() });
export type AuditPage = z.infer<typeof zAuditPage>;

export const zAuditExport = z.object({ filename: z.string(), csv: z.string(), rows: z.number().int() });
export type AuditExport = z.infer<typeof zAuditExport>;
