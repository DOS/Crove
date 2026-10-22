// The outcome of a retention hold on an evidence file (issue #1009, ADR-0013), recorded by the worker after it asked
// the store to hold the file's recorded version (apps/kernel/src/evidence-hold.ts). file_guard lets the hold columns
// change only in a system context, and held_until only grow: a hold once recorded is never cleared or shortened.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import { defineCommand } from '@crove/kernel-runtime';

// A code, never a message: members of the org read their file rows (apps/kernel/src/evidence-hold.ts holdErrorText).
const HOLD_ERROR_CODE = /^[A-Z][A-Z_]{0,31}(?::[A-Za-z][A-Za-z0-9_]{0,63})?$/;

export const recordFileHold = defineCommand({
  name: 'kernel.file.hold.record',
  // Either the retention the store confirmed, or why the attempt failed, as a code.
  input: z.union([
    z.strictObject({ fileId: zId, heldUntil: z.iso.datetime({ offset: true }) }),
    z.strictObject({ fileId: zId, error: z.string().regex(HOLD_ERROR_CODE) }),
  ]),
  risk: 'R1',
  access: 'system',
  target: (input) => ({ type: 'kernel.file', id: input.fileId }),
  handler: async (ctx, input) => {
    if ('heldUntil' in input) {
      const { rows } = await sql<{ held_until: Date }>`
        UPDATE crove_kernel.file
           SET held_until = GREATEST(coalesce(held_until, ${input.heldUntil}::timestamptz), ${input.heldUntil}::timestamptz),
               hold_attempted_at = ${ctx.now}, hold_attempts = 0, hold_error = NULL
         WHERE org_id = ${ctx.orgId} AND id = ${input.fileId}
         RETURNING held_until`.execute(ctx.trx);
      const row = rows[0];
      return { recorded: row !== undefined, heldUntil: row ? new Date(row.held_until).toISOString() : null };
    }
    const { rows } = await sql<{ id: string }>`
      UPDATE crove_kernel.file
         SET hold_attempted_at = ${ctx.now}, hold_attempts = LEAST(hold_attempts + 1, 1000), hold_error = ${input.error}
       WHERE org_id = ${ctx.orgId} AND id = ${input.fileId}
       RETURNING id`.execute(ctx.trx);
    return { recorded: rows.length > 0, heldUntil: null };
  },
});

export const fileHoldCommands = [recordFileHold];
