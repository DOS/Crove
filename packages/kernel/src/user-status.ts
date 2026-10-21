// The audit of an operator's disable or re-enable of a user account (issue #985, ADR-0028 section 2). The operator's
// `user-disable` and `user-enable` image roles set user_account.disabled_at through crove_kernel.user_set_disabled
// (worker only), then note it here in each org the user belongs to, so each org's audit log shows that the account was
// blocked or unblocked, when and why. The note is the audit row itself: it changes no tenant data. No email is kept.
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import { defineCommand } from '@crove/kernel-runtime';

export const zUserStatusNote = z.strictObject({
  userId: zId,
  disabled: z.boolean(),
  // false when the account already was in that state (a repeated run); the note is kept either way.
  changed: z.boolean(),
  reason: z.string().trim().min(1).max(500),
});

export const userStatusNote = defineCommand({
  name: 'kernel.user.status_note',
  input: zUserStatusNote,
  risk: 'R1',
  access: 'system',
  target: (input) => ({ type: 'kernel.user', id: input.userId }),
  handler: async (ctx, input) => {
    ctx.audit({ disabled: input.disabled, changed: input.changed, reason: input.reason });
    return { noted: true };
  },
});

export const userStatusCommands = [userStatusNote];
