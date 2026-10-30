// The audit of an operator's disable or re-enable of a user account (issue #985, ADR-0028 section 2). The operator's
// `user-disable` and `user-enable` image roles set user_account.disabled_at through crove_kernel.user_set_disabled
// (worker only), then note it here in each org the user belongs to, so each org's audit log shows that the account was
// blocked or unblocked, when and why. The note is the audit row itself: it changes no tenant data. No email is kept,
// and the why is a code (#1949, ADR-0017): the operator's own words are about a person and an audit row outlives every
// erasure, so they stay on the account (user_account.status_reason, mutable).
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import { defineCommand } from '@crove/kernel-runtime';

// Why an account was blocked or unblocked, as the audit row keeps it.
export const USER_STATUS_CODES = ['security', 'abuse', 'request', 'offboarding', 'other'] as const;

export const zUserStatusNote = z.strictObject({
  userId: zId,
  disabled: z.boolean(),
  // false when the account already was in that state (a repeated run); the note is kept either way.
  changed: z.boolean(),
  code: z.enum(USER_STATUS_CODES),
});

export const userStatusNote = defineCommand({
  name: 'kernel.user.status_note',
  input: zUserStatusNote,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.user', id: input.userId }),
  handler: async (ctx, input) => {
    ctx.audit({ disabled: input.disabled, changed: input.changed, code: input.code });
    return { noted: true };
  },
});

export const userStatusCommands = [userStatusNote];
