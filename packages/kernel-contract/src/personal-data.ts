// Personal-data requests under the PDPL (issue #923): the shapes of the finder an owner or admin uses to answer a
// person's request to see their data. The kernel decides what a value matches (packages/kernel/src/personal-data.ts).
import { z } from 'zod';

export const zPersonalDataQuery = z.strictObject({
  // An email address, a phone number, or a tax code or national ID.
  value: z.string().trim().min(3).max(320),
});
export type PersonalDataQuery = z.infer<typeof zPersonalDataQuery>;

export const zPersonalDataMatch = z.object({
  // schema.table.column where the value was found.
  column: z.string(),
  // What an erasure does to that column: erase, or keep (legal records, the org's own identity), with the reason.
  handling: z.enum(['erase', 'keep_legal', 'keep_org', 'keep_record']),
  reason: z.string(),
  rowId: z.string().nullable(),
  // The whole row, for the export.
  row: z.record(z.string(), z.unknown()),
});
export type PersonalDataMatch = z.infer<typeof zPersonalDataMatch>;

// How many private notes and to-dos of one author mention a value (#1678, ADR-0037): never which or their text.
export const zPrivateItemCount = z.object({ authorUserId: z.string(), notes: z.number().int(), todos: z.number().int() });

export const zPersonalDataResult = z.object({
  kind: z.enum(['email', 'digits']),
  matches: z.array(zPersonalDataMatch),
  // Private notes and to-dos that mention the value (#1678, ADR-0037): how many each author has, never which or their
  // text, so the owner can tell the authors before an erasure.
  privateItems: z.array(zPrivateItemCount),
  // A column had more matching rows than the finder returns.
  truncated: z.boolean(),
});
export type PersonalDataResult = z.infer<typeof zPersonalDataResult>;

// What an erasure did (#923): rows cleared per column, and what it kept with the reason (legal retention, the org's
// own identity, an append-only record). Counts only.
export const zPersonalDataErasure = z.object({
  erased: z.array(z.object({ column: z.string(), rows: z.number().int() })),
  kept: z.array(z.object({ column: z.string(), rows: z.number().int(), reason: z.string() })),
});
export type PersonalDataErasure = z.infer<typeof zPersonalDataErasure>;

// The owner's notice before an erasure (#1678, ADR-0037 section 5): the authors it told, with how many of their private
// notes and to-dos mention the value. The erasure deletes only the items a notice named.
export const zPersonalDataNotice = z.object({ authors: z.array(zPrivateItemCount) });
export type PersonalDataNotice = z.infer<typeof zPersonalDataNotice>;
