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
  handling: z.enum(['erase', 'keep_legal', 'keep_org']),
  reason: z.string(),
  rowId: z.string().nullable(),
  // The whole row, for the export.
  row: z.record(z.string(), z.unknown()),
});
export type PersonalDataMatch = z.infer<typeof zPersonalDataMatch>;

export const zPersonalDataResult = z.object({
  kind: z.enum(['email', 'digits']),
  matches: z.array(zPersonalDataMatch),
  // A column had more matching rows than the finder returns.
  truncated: z.boolean(),
});
export type PersonalDataResult = z.infer<typeof zPersonalDataResult>;
