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
  zOAuthProvider,
  zOAuthState,
  zSocialDecide,
  zSocialPost,
  zSocialPostCreate,
  zSocialPostUpdate,
  zSocialQueue,
  zSocialMetricsRow,
  zSocialLibraryItem,
  zSocialLibraryUse,
  zSocialQueueSet,
  zSocialSchedule,
  zSocialVariantUpdate,
  zSocialChannelInput,
  SOCIAL_POST_STATUSES,
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
  zVatPeriod,
  zVatReport,
  zAccountLedger,
  zLedgerPeriod,
  zLedgerReport,
} from './schemas.ts';
import { zOpeningBalanceImport, zOpeningBalancePreview } from './opening-balance.ts';

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
    // Bluesky with an app password (S9): checked once by opening a session, then sealed; the account password is refused.
    connectBluesky: oc
      // The format of an app password is checked by the server, which says so in words rather than as a validation error.
      .input(z.object({ handle: z.string().trim().min(3).max(260), appPassword: z.string().trim().min(1).max(100) }))
      .output(z.object({ connectionId: zId, reconnected: z.boolean() })),
    // Connecting through a provider's OAuth dialog (Social plan S6). Start returns where to send the browser; the
    // provider sends it back to /channels/oauth/:provider/callback, and that screen finishes the attempt with the code
    // and state. Finish connects every account the grant covers (for Facebook, the Pages picked in Meta's dialog).
    oauthStart: oc
      .input(z.object({ provider: zOAuthProvider }))
      .output(z.object({ authorizeUrl: z.url({ protocol: /^https$/ }), state: zOAuthState, expiresAt: z.iso.datetime({ offset: true }) })),
    oauthFinish: oc
      .input(z.object({ provider: zOAuthProvider, state: zOAuthState, code: z.string().min(1).max(2048) }))
      .output(z.object({ connections: z.array(z.object({ connectionId: zId, displayName: z.string(), reconnected: z.boolean() })) })),
  },
  // Crove Social (Social plan §3.3), when the deployment runs the social module.
  social: {
    posts: {
      list: oc
        .input(z.object({ from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(), status: z.enum(SOCIAL_POST_STATUSES).optional(), limit: z.number().int().min(1).max(200).optional() }))
        .output(z.array(zSocialPost)),
      get: oc.input(z.object({ postId: zId })).output(zSocialPost),
      // A retry with the same idempotencyKey returns the first result instead of a second post.
      create: oc
        .input(zSocialPostCreate.extend({ idempotencyKey: zId }))
        .output(z.object({ postId: zId, revision: z.number().int(), variants: z.array(z.object({ variantId: zId, connectionId: zId })) })),
      update: oc.input(zSocialPostUpdate).output(z.object({ postId: zId, revision: z.number().int(), changedVariants: z.array(zId) })),
      addChannels: oc
        .input(z.strictObject({ postId: zId, channels: z.array(zSocialChannelInput).min(1).max(20) }))
        .output(z.object({ postId: zId, variants: z.array(z.object({ variantId: zId, connectionId: zId })) })),
      submit: oc.input(z.strictObject({ postId: zId, variantIds: z.array(zId).min(1).max(20).optional() })).output(z.object({ postId: zId, submitted: z.array(zId) })),
      // A new post with the content of a published one, for the channels it went out on (S9); it is reviewed as usual.
      repost: oc.input(z.strictObject({ postId: zId })).output(z.object({ postId: zId })),
      // Repost a published post every N days (7 to 365), each repost sent to review; null stops it.
      setEvergreen: oc.input(z.strictObject({ postId: zId, days: z.number().int().min(7).max(365).nullable() })).output(z.object({ postId: zId, evergreenDays: z.number().int().nullable() })),
      // AI drafting (Social plan §3.7): the server asks the deployment's model for a draft from the brief and saves it as
      // a new post with origin 'ai' (tainted), one variant per channel. Each call drafts anew: a draft whose answer was
      // lost is only an extra draft, which publishes nothing until a person approves it.
      draftWithAi: oc
        .input(
          z.strictObject({
            brief: z.string().trim().min(1).max(4000),
            connectionIds: z.array(zId).min(1).max(20),
            tone: z.string().trim().max(300).optional(),
            language: z.enum(['vi', 'en']).optional(),
          }),
        )
        .output(z.object({ postId: zId })),
    },
    // How published posts did (S8): the latest capture of each variant published in the last days days (30 by default).
    metrics: {
      summary: oc.input(z.object({ days: z.number().int().min(1).max(365).optional() })).output(z.array(zSocialMetricsRow)),
    },
    // The media library (S9): the org's post images, newest first, and the posts that show one.
    media: {
      list: oc
        .input(z.object({ search: z.string().trim().max(200).optional(), before: z.strictObject({ createdAt: z.iso.datetime({ offset: true }), fileId: zId }).optional(), limit: z.number().int().min(1).max(100).optional() }))
        .output(z.object({ items: z.array(zSocialLibraryItem), more: z.boolean() })),
      usage: oc.input(z.object({ fileId: zId })).output(z.array(zSocialLibraryUse)),
    },
    variants: {
      update: oc.input(zSocialVariantUpdate).output(z.object({ variantId: zId, revision: z.number().int(), changed: z.boolean() })),
      decide: oc.input(zSocialDecide).output(z.object({ postId: zId, decision: z.string(), variants: z.array(zId) })),
      schedule: oc.input(zSocialSchedule).output(z.object({ postId: zId, scheduled: z.array(z.object({ variantId: zId, at: z.string() })) })),
      unschedule: oc.input(z.strictObject({ variantIds: z.array(zId).min(1).max(20) })).output(z.object({ postId: zId, variants: z.array(zId) })),
      cancel: oc.input(z.strictObject({ variantIds: z.array(zId).min(1).max(20) })).output(z.object({ postId: zId, variants: z.array(zId) })),
      // Publish failed or needs_attention variants again now (a new attempt).
      retry: oc.input(z.strictObject({ variantIds: z.array(zId).min(1).max(20) })).output(z.object({ postId: zId, variants: z.array(zId) })),
      // Settle needs_attention variants: on the platform after all, or dropped.
      resolve: oc
        .input(z.strictObject({ variantIds: z.array(zId).min(1).max(20), outcome: z.enum(['published', 'dropped']), url: z.url({ protocol: /^https?$/ }).max(2000).nullable().optional() }))
        .output(z.object({ postId: zId, variants: z.array(zId), outcome: z.enum(['published', 'dropped']) })),
    },
    queues: {
      get: oc.input(z.object({ connectionId: zId })).output(zSocialQueue),
      set: oc.input(zSocialQueueSet).output(z.object({ queueId: zId, moved: z.array(z.object({ variantId: zId, at: z.string().nullable() })) })),
    },
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
    // Owners and admins (R1, #319): the debit account proposed first for a vendor's invoices, a TT133 account or an
    // active sub-account; null clears it (the keyword rules apply again).
    setDefaultAccount: oc
      .input(z.object({ partyId: zId, accountCode: zAccountCode.nullable() }))
      .output(z.object({ partyId: zId, accountCode: zAccountCode.nullable() })),
  },
  documents: {
    list: oc.input(z.object({ from: zLocalDate.optional(), to: zLocalDate.optional() })).output(z.array(zPurchaseDocument)),
  },
  journal: {
    list: oc.input(z.object({ from: zLocalDate.optional(), to: zLocalDate.optional() })).output(z.array(zJournalEntry)),
    // One entry, for example the one a reversal proposal names.
    get: oc.input(z.object({ id: zId })).output(zJournalEntry),
  },
  // Opening balances from Excel (#320), owners and admins. preview checks a trial balance read from the template and
  // writes nothing; post checks it again and posts it as the org's one opening entry (R3: fresh MFA). A retry with the
  // same idempotencyKey returns the first result. To replace an opening entry, reverse it first.
  openingBalance: {
    preview: oc.input(zOpeningBalanceImport).output(zOpeningBalancePreview),
    post: oc
      .input(zOpeningBalanceImport.extend({ idempotencyKey: zId }))
      .output(z.object({ journalEntryId: zId, lines: z.number().int().positive() })),
  },
  // The org's chart: the TT133 accounts and its own sub-accounts (#319), inactive ones included (pickers hide them).
  accounts: {
    list: oc.output(z.array(zAccount)),
    // Owners and admins (R1): a sub-account under a TT133 account or a digit sub-account (11211, 1121.VCB).
    create: oc
      .input(z.object({ parentCode: zAccountCode, code: zAccountCode, name: z.string().trim().min(1).max(200) }))
      .output(z.object({ id: zId, code: zAccountCode })),
    // Owners and admins (R1): renames, deactivates or reactivates a sub-account. TT133 accounts are read-only; an
    // account stays active while it is a vendor's default or has active sub-accounts.
    update: oc
      .input(z.object({ code: zAccountCode, name: z.string().trim().min(1).max(200).optional(), active: z.boolean().optional() }))
      .output(z.object({ code: zAccountCode, name: z.string(), active: z.boolean() })),
  },
  // VAT working for one month or quarter (issue #316); the Excel file is GET /api/export/vat.xlsx?period=<period>.
  vat: {
    period: oc.input(z.object({ period: zVatPeriod })).output(zVatReport),
  },
  // Ledger reports of a month, quarter or year (issue #321): the trial balance and the receivables and payables per
  // party, and the general ledger of one account. The Excel workbook is GET /api/export/ledger.xlsx?period=<period>.
  ledger: {
    period: oc.input(z.object({ period: zLedgerPeriod })).output(zLedgerReport),
    account: oc.input(z.object({ period: zLedgerPeriod, accountCode: zAccountCode })).output(zAccountLedger),
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
