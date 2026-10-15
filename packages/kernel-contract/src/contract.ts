import { oc } from '@orpc/contract';
import { z } from 'zod';
import {
  zAccount,
  zAccountCode,
  zFileStatus,
  zId,
  zInboxDetail,
  zInboxItem,
  zJournalEntry,
  zLocalDate,
  zMe,
  zOrgDetail,
  zOrgSummary,
  zParty,
  zProposalStatus,
  zPurchaseDocument,
  zRole,
  zSession,
  zSessionRevoke,
} from './schemas.ts';

// The org for org-scoped procedures comes from the `x-crove-org` header (slug), never from input.
export const contract = {
  me: {
    get: oc.output(zMe),
  },
  org: {
    // A retry with the same idempotencyKey returns the org the first request created.
    create: oc.input(z.object({ name: z.string().trim().min(1).max(200), idempotencyKey: zId })).output(zOrgSummary),
    get: oc.output(zOrgDetail),
    addMember: oc
      .input(z.object({ email: z.email(), role: zRole.exclude(['owner']) }))
      .output(z.object({ userId: zId })),
  },
  // Sessions (devices) of a member of the org in the header. API only; the screen is a follow-up.
  sessions: {
    list: oc.input(z.object({ userId: zId })).output(z.array(zSession)),
    revoke: oc.input(zSessionRevoke).output(z.object({ revoked: z.array(zId) })),
  },
  inbox: {
    list: oc.input(z.object({ status: zProposalStatus.optional() })).output(z.array(zInboxItem)),
    get: oc.input(z.object({ id: zId })).output(zInboxDetail),
    approve: oc
      .input(
        z.object({
          id: zId,
          revision: z.number().int().positive(),
          lineAccounts: z.array(z.object({ lineNo: z.number().int().positive(), debitAccount: zAccountCode })).optional(),
          note: z.string().max(500).optional(),
          acceptFailedChecks: z.boolean().optional(),
          idempotencyKey: zId,
        }),
      )
      .output(z.object({ documentId: zId, journalEntryId: zId })),
    // Saves changed line accounts as a new revision authored by the caller; it never approves.
    edit: oc
      .input(
        z.object({
          id: zId,
          revision: z.number().int().positive(),
          lineAccounts: z.array(z.object({ lineNo: z.number().int().positive(), debitAccount: zAccountCode })).min(1).max(1000),
          idempotencyKey: zId,
        }),
      )
      .output(z.object({ revision: z.number().int(), changed: z.boolean() })),
    reject: oc.input(z.object({ id: zId, reason: z.string().max(500).optional() })).output(z.object({ ok: z.literal(true) })),
  },
  files: {
    recent: oc.output(z.array(zFileStatus)),
  },
  parties: {
    list: oc.input(z.object({ q: z.string().max(100).optional() })).output(z.array(zParty)),
  },
  documents: {
    list: oc.input(z.object({ from: zLocalDate.optional(), to: zLocalDate.optional() })).output(z.array(zPurchaseDocument)),
  },
  journal: {
    list: oc.input(z.object({ from: zLocalDate.optional(), to: zLocalDate.optional() })).output(z.array(zJournalEntry)),
  },
  accounts: {
    list: oc.output(z.array(zAccount)),
  },
};

export type Contract = typeof contract;
