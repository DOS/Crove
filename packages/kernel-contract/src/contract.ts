import { oc } from '@orpc/contract';
import { z } from 'zod';
import {
  zAccount,
  zAgentBudget,
  zAgentRisk,
  zAgentRoleKey,
  zAgentScope,
  zAgentStatus,
  zAgentTemplate,
  zAiAmount,
  zChart,
  zJobDescription,
  zModuleId,
  zPositionStatus,
  zTask,
  zTaskDetail,
  zTaskStatus,
  zAccountCode,
  zChannelConnection,
  zFileStatus,
  zId,
  zInboxDetail,
  zInboxItem,
  zInvite,
  zInviteCreated,
  zInvitePreview,
  zInviteRole,
  zInviteToken,
  zJournalEntry,
  zJournalReversal,
  zLocalDate,
  zMe,
  zOrgDetail,
  zOrgExport,
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
    // Owners and admins (admins cannot invite admins). R3: needs fresh MFA. Nobody becomes a member until the
    // invitee accepts (invites.accept). The answer is the same whether or not the email has an account.
    invite: oc.input(z.object({ email: z.email().max(320), role: zInviteRole })).output(zInviteCreated),
    // Owners and admins: the org's invites that are still pending or expired, newest first.
    listInvites: oc.output(z.array(zInvite)),
    revokeInvite: oc.input(z.object({ inviteId: zId })).output(z.object({ ok: z.literal(true) })),
    // Owner only. Retires the org's inbound email address for good and returns the new one (null when the server
    // has no inbound domain). A retry with the same idempotencyKey does not rotate again.
    rotateInbound: oc.input(z.object({ idempotencyKey: zId })).output(z.object({ inboundAddress: z.string().nullable() })),
    // Owners only (R3). A retry with the same idempotencyKey returns the first result.
    changeMemberRole: oc
      .input(z.object({ userId: zId, role: zRole, idempotencyKey: zId }))
      .output(z.object({ userId: zId, role: zRole, previousRole: zRole })),
    removeMember: oc.input(z.object({ userId: zId, idempotencyKey: zId })).output(z.object({ userId: zId, previousRole: zRole })),
    // Owner only (R3, issue #38): the owner types the org's slug to confirm. The org moves to 'offboarding', where only
    // owners can enter it, and the worker exports its data. Run again while offboarding, it asks for a new export.
    offboard: oc
      .input(z.object({ confirmSlug: z.string().max(48), idempotencyKey: zId }))
      .output(z.object({ status: z.literal('offboarding'), exportRequested: z.literal(true) })),
    // Owner only: the offboarding state and the newest finished export.
    export: oc.output(zOrgExport),
  },
  // Org-less: the signed-in invitee previews and accepts an invite by its token. Only the invited email may.
  invites: {
    peek: oc.input(z.object({ token: zInviteToken })).output(zInvitePreview),
    accept: oc.input(z.object({ token: zInviteToken })).output(zOrgSummary),
  },
  // Sessions (devices) of a member of the org in the header. API only; the screen is a follow-up.
  sessions: {
    list: oc.input(z.object({ userId: zId })).output(z.array(zSession)),
    revoke: oc.input(zSessionRevoke).output(z.object({ revoked: z.array(zId) })),
  },
  // Connected channel accounts (ADR-0025). Every member lists them; owners and admins connect and disconnect.
  channels: {
    list: oc.input(z.object({ includeRevoked: z.boolean().optional() })).output(z.array(zChannelConnection)),
    // The offline sandbox channel, when the deployment enables it. Connecting again with the same key reconnects the
    // same sandbox account.
    connectSandbox: oc
      .input(z.object({ displayName: z.string().trim().min(1).max(200), key: zId }))
      .output(z.object({ connectionId: zId, reconnected: z.boolean() })),
    disconnect: oc.input(z.object({ connectionId: zId, idempotencyKey: zId })).output(z.object({ connectionId: zId, status: z.literal('revoked') })),
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
      // A purchase returns its document; a reversal (#138) returns the entry it reversed and, when that entry recorded a
      // purchase, the document it voided (#165).
      .output(z.object({ documentId: zId.optional(), journalEntryId: zId, reversedEntryId: zId.optional(), voidedDocumentId: zId.optional() })),
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
    // Asks for a proposal that no file produced (kernel.proposal.request; owners, admins and members): today only
    // reversing a posted journal entry (#138, #165). It posts nothing; the proposal is approved like any other (R3,
    // P10 four-eyes, P11 step-up). Reversing a purchase entry also voids Crove's record of the document on approval.
    // A retry with the same idempotencyKey returns the first proposal.
    request: oc
      .input(z.object({ command: z.literal('finance.journal.reverse'), input: zJournalReversal, idempotencyKey: zId }))
      .output(z.object({ proposalId: zId })),
  },
  files: {
    recent: oc.output(z.array(zFileStatus)),
    // Owners, admins and members: reads the file again (issue #40). The result is a new extraction version and,
    // when it reads an invoice, a new revision of the file's pending proposal (or a new proposal after a rejected
    // one). Refused while a run is in flight and once the invoice is booked. A retry with the same idempotencyKey
    // returns the first result.
    reextract: oc.input(z.object({ fileId: zId, idempotencyKey: zId })).output(z.object({ fileId: zId, version: z.number().int() })),
  },
  parties: {
    list: oc.input(z.object({ q: z.string().max(100).optional() })).output(z.array(zParty)),
  },
  documents: {
    list: oc.input(z.object({ from: zLocalDate.optional(), to: zLocalDate.optional() })).output(z.array(zPurchaseDocument)),
  },
  journal: {
    list: oc.input(z.object({ from: zLocalDate.optional(), to: zLocalDate.optional() })).output(z.array(zJournalEntry)),
    // One entry, for example the one a reversal proposal names.
    get: oc.input(z.object({ id: zId })).output(zJournalEntry),
  },
  accounts: {
    list: oc.output(z.array(zAccount)),
  },
  // The org chart (ADR-0029): positions shared by members and AI agents. Every member reads it; changing it is the
  // owner's (R3: role keys, holders and reporting lines decide what agents may do). A retry with the same
  // idempotencyKey returns the first result.
  chart: {
    get: oc.output(zChart),
    createPosition: oc
      .input(
        z.object({
          title: z.string().trim().min(1).max(200),
          module: zModuleId,
          roleKey: zAgentRoleKey,
          reportsTo: zId.nullable().optional(),
          jobDescription: zJobDescription.optional(),
          idempotencyKey: zId,
        }),
      )
      .output(z.object({ positionId: zId })),
    updatePosition: oc
      .input(
        z.object({
          id: zId,
          title: z.string().trim().min(1).max(200).optional(),
          reportsTo: zId.nullable().optional(),
          status: zPositionStatus.optional(),
          idempotencyKey: zId,
        }),
      )
      .output(z.object({ positionId: zId })),
    // Gives the position to a member or an active agent of a matching template, or vacates it (holder null).
    assign: oc
      .input(
        z.object({
          id: zId,
          holder: z.discriminatedUnion('type', [z.object({ type: z.literal('user'), userId: zId }), z.object({ type: z.literal('agent'), agentId: zId })]).nullable(),
          idempotencyKey: zId,
        }),
      )
      .output(z.object({ positionId: zId })),
    // The agent templates modules declare; moduleEnabled false means installing it answers MODULE_DISABLED.
    templates: oc.output(z.array(zAgentTemplate)),
    // Owner (R3): an agent and the position it holds, from a template. MODULE_DISABLED when the deployment does not
    // enable the template's module.
    installTemplate: oc
      .input(
        z.object({
          templateKey: z.string().min(1).max(100),
          reportsTo: zId.nullable().optional(),
          displayName: z.string().trim().min(1).max(200).optional(),
          idempotencyKey: zId,
        }),
      )
      .output(z.object({ agentId: zId, positionId: zId })),
  },
  agents: {
    // Owner (R3): status (pausing or retiring stops its runs at once), max_risk, name and daily run cap.
    update: oc
      .input(
        z.object({
          id: zId,
          status: zAgentStatus.optional(),
          maxRisk: zAgentRisk.optional(),
          displayName: z.string().trim().min(1).max(200).optional(),
          dailyRunCap: z.number().int().min(1).max(10000).optional(),
          idempotencyKey: zId,
        }),
      )
      .output(z.object({ agentId: zId })),
    // Owners and admins: the monthly budgets and this month's spend.
    budgets: oc.output(z.array(zAgentBudget)),
    // Owner (R3): sets the monthly budget of the org (target '*'), a module or an agent.
    setBudget: oc
      .input(
        z.object({
          scope: zAgentScope,
          target: z.string().min(1).max(100),
          monthlyLimit: zAiAmount,
          warnPercent: z.number().int().min(1).max(100).optional(),
          hardStop: z.boolean().optional(),
          idempotencyKey: zId,
        }),
      )
      .output(z.object({ budgetId: zId })),
    // "Stop AI": owners and admins, R1, so it never waits for a second factor. Engaging a switch that is already on
    // is a no-op that returns it.
    stop: oc
      .input(z.object({ scope: zAgentScope, target: z.string().min(1).max(100), reason: z.string().max(500).optional(), idempotencyKey: zId }))
      .output(z.object({ killSwitchId: zId, stoppedRuns: z.number().int() })),
    // Owner (R3, fresh MFA): turns a kill switch off again.
    release: oc.input(z.object({ id: zId, idempotencyKey: zId })).output(z.object({ ok: z.literal(true) })),
  },
  // Work given to positions, held by members or agents (ADR-0029). Every member reads; owners, admins and members
  // create, comment and change status.
  tasks: {
    list: oc.input(z.object({ positionId: zId.optional(), mine: z.boolean().optional(), status: z.array(zTaskStatus).max(6).optional() })).output(z.array(zTask)),
    get: oc.input(z.object({ id: zId })).output(zTaskDetail),
    create: oc
      .input(
        z.object({
          title: z.string().trim().min(1).max(300),
          description: z.string().max(10000).optional(),
          assigneePositionId: zId.nullable(),
          due: z.iso.datetime().optional(),
          idempotencyKey: zId,
        }),
      )
      .output(z.object({ taskId: zId })),
    comment: oc.input(z.object({ id: zId, body: z.string().trim().min(1).max(10000), idempotencyKey: zId })).output(z.object({ commentId: zId })),
    setStatus: oc.input(z.object({ id: zId, status: zTaskStatus, idempotencyKey: zId })).output(z.object({ taskId: zId, status: zTaskStatus })),
  },
};

export type Contract = typeof contract;
